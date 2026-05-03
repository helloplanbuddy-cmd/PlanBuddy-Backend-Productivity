'use strict';

/**
 * controllers/healthController.js — Production Health + Readiness Probes (v3.0)
 *
 * UPGRADES from v2.0:
 *  1. Readiness probe now checks Redis connectivity (new dependency in v3.0).
 *  2. Detailed probe includes BullMQ queue depth for each queue.
 *  3. DB pool stats included (idle/total/waiting connections).
 *  4. Uses Pino logger (req.log child logger if available).
 *  5. asyncHandler wrapper not used here — health checks must not throw,
 *     they catch internally and return degraded status.
 *
 * Endpoints:
 *   GET /api/health          — liveness (is process alive?)
 *   GET /api/health/ready    — readiness (can serve traffic? DB + Redis required)
 *   GET /api/health/detailed — deep check (DB, Redis, queues, Razorpay — admin auth)
 */

const db             = require('../config/db');
const { isHealthy: redisHealthy } = require('../config/redis');
const razorpayConfig = require('../config/razorpay');
const logger         = require('../utils/logger');

// 🔥 PHASE 3: Import backpressure status
let backpressureStatus = { activeRequests: 0, isOverloaded: false };
try {
  const bp = require('../middleware/backpressure');
  backpressureStatus = bp.getBackpressureStatus();
} catch (_) {
  // Backpressure might not be loaded yet
}

// ─── GET /api/health — Liveness ───────────────────────────────────────────────

exports.liveness = (req, res) => {
  res.json({
    status:    'alive',
    pid:       process.pid,
    uptime:    Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
};

// ─── GET /api/health/ready — Readiness ───────────────────────────────────────

exports.readiness = async (req, res) => {
  const checks = {};
  let   allOk  = true;

  // ── 1. PostgreSQL connectivity ──────────────────────────────────────────
  try {
    const start = Date.now();
    await db.query('SELECT 1');
    checks.database = { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    checks.database = { status: 'error', error: err.message };
    allOk = false;
    logger.error({ err }, '[health/ready] DB check failed');
  }

  // ── 2. Critical table existence ─────────────────────────────────────────
  try {
    await db.query('SELECT 1 FROM razorpay_order_mappings LIMIT 0');
    checks.schema = { status: 'ok' };
  } catch (err) {
    checks.schema = { status: 'error', missing: 'razorpay_order_mappings', error: err.message };
    allOk = false;
  }

  // ── 3. Redis connectivity ───────────────────────────────────────────────
  try {
    const result = await redisHealthy();
    checks.redis = result;
    if (result.status !== 'ok') allOk = false;
  } catch (err) {
    checks.redis = { status: 'error', error: err.message };
    allOk = false;
    logger.error({ err }, '[health/ready] Redis check failed');
  }

// ── 4. Memory pressure ──────────────────────────────────────────────────
  const mem     = process.memoryUsage();
  const heapMb  = Math.round(mem.heapUsed  / 1024 / 1024);
  const totalMb = Math.round(mem.heapTotal / 1024 / 1024);
  checks.memory = {
    heapUsedMb:  heapMb,
    heapTotalMb: totalMb,
    status:      heapMb < 450 ? 'ok' : 'warn',
  };

  // 🔥 PHASE 3: Backpressure status
  try {
    const bp = require('../middleware/backpressure');
    checks.backpressure = bp.getBackpressureStatus();
    if (checks.backpressure.isOverloaded) allOk = false;
  } catch (_) {
    checks.backpressure = { status: 'not_initialized' };
  }

  res.status(allOk ? 200 : 503).json({
    status:    allOk ? 'ready' : 'not_ready',
    checks,
    uptime:    Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    version:   require('../package.json').version,
    nodeEnv:   require('../config/env').NODE_ENV,
  });
};

// ─── GET /api/health/detailed — Deep Check (admin auth required) ──────────────

exports.detailed = async (req, res, next) => {
  try {
    const checks = {};
    let   allOk  = true;

    // ── 1. DB deep check ──────────────────────────────────────────────────
    try {
      const [dbPing, tableCount, paymentMismatches, orphanRefunds] = await Promise.all([
        db.healthcheck(),
        db.query('SELECT COUNT(*) FROM bookings'),
        db.query(`
          SELECT COUNT(*) FROM payments p
          JOIN bookings b ON p.booking_id = b.id
          WHERE p.status = 'captured'
            AND (b.status != 'confirmed' OR b.payment_status != 'paid')
        `),
        // RISK-005: orphaned refunds (refunded payment, booking still confirmed)
        db.query(`
          SELECT COUNT(*) FROM payments p
          JOIN bookings b ON p.booking_id = b.id
          WHERE p.status = 'refunded'
            AND b.status = 'confirmed'
            AND b.payment_status = 'paid'
        `),
      ]);

      checks.database = {
        status:           'ok',
        latencyMs:        dbPing.latencyMs,
        pgVersion:        dbPing.pgVersion,
        totalBookings:    parseInt(tableCount.rows[0].count, 10),
        paymentMismatches: parseInt(paymentMismatches.rows[0].count, 10),
        orphanedRefunds:  parseInt(orphanRefunds.rows[0].count, 10),
        pool:             db.poolStats(),
      };
    } catch (err) {
      checks.database = { status: 'error', error: err.message };
      allOk = false;
    }

    // ── 2. Redis deep check ───────────────────────────────────────────────
    try {
      const result = await redisHealthy();
      checks.redis = result;
      if (result.status !== 'ok') allOk = false;
    } catch (err) {
      checks.redis = { status: 'error', error: err.message };
      allOk = false;
    }

    // ── 3. BullMQ queue depths ────────────────────────────────────────────
    try {
      const {
        bookingExpiryQueue, reconciliationQueue, emailQueue, refundRetryQueue,
      } = require('../config/queues');

      const queueStats = await Promise.all([
        Promise.all([bookingExpiryQueue.getWaitingCount(), bookingExpiryQueue.getFailedCount()])
          .then(([w, f]) => ({ name: 'booking-expiry', waiting: w, failed: f })),
        Promise.all([reconciliationQueue.getWaitingCount(), reconciliationQueue.getFailedCount()])
          .then(([w, f]) => ({ name: 'payment-reconciliation', waiting: w, failed: f })),
        Promise.all([emailQueue.getWaitingCount(), emailQueue.getFailedCount()])
          .then(([w, f]) => ({ name: 'email-dispatch', waiting: w, failed: f })),
        Promise.all([refundRetryQueue.getWaitingCount(), refundRetryQueue.getFailedCount()])
          .then(([w, f]) => ({ name: 'refund-retry', waiting: w, failed: f })),
      ]);

      checks.queues = queueStats;

      // Warn if any queue has stuck failed jobs
      const hasFailedJobs = queueStats.some(q => q.failed > 10);
      if (hasFailedJobs) checks.queueAlert = 'Some queues have elevated failed job counts';
    } catch (err) {
      checks.queues = { status: 'error', error: err.message };
    }

    // ── 4. Razorpay connectivity ──────────────────────────────────────────
    if (razorpayConfig.keyId && razorpayConfig.keySecret) {
      try {
        const start = Date.now();
        await razorpayConfig.client.orders.all({ count: 1 });
        checks.razorpay = { status: 'ok', latencyMs: Date.now() - start };
      } catch (err) {
        checks.razorpay = { status: 'degraded', error: err.message };
        // Razorpay downtime is degraded but not fatal — webhooks buffer events
      }
    } else {
      checks.razorpay = { status: 'not_configured' };
    }

    // ── 5. Process stats ──────────────────────────────────────────────────
    const mem = process.memoryUsage();
    checks.process = {
      heapUsedMb:  Math.round(mem.heapUsed  / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      rssMb:       Math.round(mem.rss       / 1024 / 1024),
      uptimeSecs:  Math.round(process.uptime()),
      pid:         process.pid,
      nodeVersion: process.version,
    };

    res.status(allOk ? 200 : 503).json({
      status:    allOk ? 'healthy' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
};
