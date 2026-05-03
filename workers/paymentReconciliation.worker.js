'use strict';

/**
 * workers/paymentReconciliation.worker.js — Payment Recovery Engine
 *
 * PHASE 4: Guaranteed Payment Recovery (ZERO MONEY LOSS)
 *
 * Problem:
 *  - Webhook lost in transit
 *  - DB commit fails after Razorpay capture
 *  - Race conditions at high load
 *
 * Solution:
 *  - Run every 2 minutes
 *  - Find orphaned payments (created > 2 min ago, no confirmation)
 *  - Call Razorpay API directly to verify status
 *  - Auto-recover: force-confirm if captured, mark failed if not
 *  - Idempotent: safe to run 100 times for same payment
 */

const db = require('../config/db');
const RazorpayService = require('../services/razorpayService');
const logger = require('../utils/logger');
const monitoring = require('../utils/monitoring');
const {
  safeWorkerWrapper,
  JobStateManager,
  isTransientError,
} = require('../services/workerSafetyService');

const WORKER_ID = `payment-recovery-${process.pid}`;
const QUEUE_NAME = 'payment-recovery';
const JOB_NAME = 'payment-recovery';
const RUN_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Find orphaned payments.
 * Payments that are 'created' or 'pending' for > 2 minutes without confirmation.
 */
async function findOrphanedPayments() {
  const result = await db.query(
    `SELECT 
      p.id AS payment_id,
      p.razorpay_payment_id,
      p.razorpay_order_id,
      p.booking_id,
      p.status AS payment_status,
      p.amount,
      b.status AS booking_status,
      b.payment_status AS booking_payment_status,
      p.created_at
    FROM payments p
    LEFT JOIN bookings b ON p.booking_id = b.id
    WHERE p.status IN ('created', 'pending')
      AND p.created_at < NOW() - INTERVAL '2 minutes'
    ORDER BY p.created_at ASC
    LIMIT 100`
  );

  return result.rows;
}

/**
 * Recover a single payment by calling Razorpay API.
 * Returns: { recovered: boolean, action: string, details: object }
 */
async function recoverPayment(payment) {
  const { payment_id, razorpay_payment_id, razorpay_order_id, booking_id, amount } = payment;

  // If no Razorpay payment ID, can't recover
  if (!razorpay_payment_id) {
    return {
      recovered: false,
      action: 'no_razorpay_id',
      details: { payment_id },
    };
  }

  try {
    // Call Razorpay API to get actual status
    const razorpayPayment = await RazorpayService.verifyPaymentWithAPI(razorpay_payment_id);

    if (!razorpayPayment) {
      // Payment not found in Razorpay - might be pending or failed
      return {
        recovered: false,
        action: 'razorpay_not_found',
        details: { payment_id, razorpay_payment_id },
      };
    }

    const razorpayStatus = razorpayPayment.status; // 'captured', 'failed', 'refunded'

    // Log the reconciliation attempt
    await db.query(
      `INSERT INTO payment_reconciliation_logs
        (payment_id, razorpay_payment_id, booking_id, status_before, status_after, action_taken, amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [payment_id, razorpay_payment_id, booking_id, payment.payment_status, razorpayStatus, 'api_check', amount]
    );

    // If captured - force confirm the booking
    if (razorpayStatus === 'captured') {
      await db.transaction(async (client) => {
        // Update payment status
        await client.query(
          `UPDATE payments
           SET status = 'captured', updated_at = NOW()
           WHERE id = $1`,
          [payment_id]
        );

        // Confirm booking if not already confirmed
        if (payment.booking_status !== 'confirmed') {
          await client.query(
            `UPDATE bookings
             SET status = 'confirmed',
                 payment_status = 'paid',
                 confirmed_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1`,
            [booking_id]
          );

          // Mark reconciliation checked
          await client.query(
            `UPDATE bookings
             SET reconciliation_checked_at = NOW(),
                 last_recovery_attempt = NOW()
             WHERE id = $1`,
            [booking_id]
          );
        }
      });

      logger.info('Payment recovered via API', {
        payment_id,
        razorpay_payment_id,
        booking_id,
        razorpayStatus,
      });

      return {
        recovered: true,
        action: 'confirmed',
        details: { payment_id, razorpay_payment_id, booking_id, razorpayStatus },
      };
    }

    // If failed - mark booking as failed
    if (razorpayStatus === 'failed') {
      await db.transaction(async (client) => {
        await client.query(
          `UPDATE payments
           SET status = 'failed', updated_at = NOW()
           WHERE id = $1`,
          [payment_id]
        );

        if (booking_id) {
          await client.query(
            `UPDATE bookings
             SET status = 'failed',
                 payment_status = 'failed',
                 updated_at = NOW()
             WHERE id = $1`,
            [booking_id]
          );
        }
      });

      logger.warn('Payment marked as failed after reconciliation', {
        payment_id,
        razorpay_payment_id,
        booking_id,
      });

      return {
        recovered: true,
        action: 'marked_failed',
        details: { payment_id, razorpay_payment_id, booking_id, razorpayStatus },
      };
    }

    // If refunded - sync state
    if (razorpayStatus === 'refunded') {
      await db.transaction(async (client) => {
        await client.query(
          `UPDATE payments
           SET status = 'refunded', updated_at = NOW()
           WHERE id = $1`,
          [payment_id]
        );

        if (booking_id) {
          await client.query(
            `UPDATE bookings
             SET payment_status = 'refunded',
                 status = 'cancelled',
                 cancelled_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1`,
            [booking_id]
          );
        }
      });

      return {
        recovered: true,
        action: 'synced_refunded',
        details: { payment_id, razorpay_payment_id, booking_id, razorpayStatus },
      };
    }

    // Unknown status - leave as-is
    return {
      recovered: false,
      action: 'unknown_razorpay_status',
      details: { payment_id, razorpay_payment_id, razorpayStatus },
    };
  } catch (err) {
    logger.error('Payment recovery failed', {
      payment_id,
      razorpay_payment_id,
      error: err.message,
    });

    return {
      recovered: false,
      action: 'error',
      details: { payment_id, razorpay_payment_id, error: err.message },
    };
  }
}

/**
 * Main reconciliation cycle.
 */
async function runReconciliation() {
  const correlationId = `pay-rec-${Date.now()}`;
  logger.info('Payment reconciliation started', { correlationId });

  let processed = 0;
  let recovered = 0;
  let failed = 0;

  try {
    const orphanedPayments = await findOrphanedPayments();
    monitoring.payment_reconciliation_total.inc(orphanedPayments.length);

    logger.info('Payment reconciliation: found orphans', {
      correlationId,
      count: orphanedPayments.length,
    });

    for (const payment of orphanedPayments) {
      // Idempotent: check if already processed recently
      const recentLog = await db.query(
        `SELECT 1 FROM payment_reconciliation_logs
         WHERE payment_id = $1
           AND created_at > NOW() - INTERVAL '5 minutes'
           AND action_taken = 'confirmed'`,
        [payment.payment_id]
      );

      if (recentLog.rows.length > 0) {
        logger.debug('Payment already recovered recently', { payment_id: payment.payment_id });
        continue;
      }

      const result = await recoverPayment(payment);
      processed++;

      if (result.recovered) {
        recovered++;
        monitoring.payment_recovery_success_total.inc();
      } else {
        failed++;
      }
    }

    const stats = { processed, recovered, failed, total: orphanedPayments.length };
    logger.info('Payment reconciliation complete', { correlationId, stats });

    return stats;
  } catch (err) {
    logger.error('Payment reconciliation failed', {
      correlationId,
      error: err.message,
      stack: err.stack,
    });

    return { processed, recovered, failed, error: err.message };
  }
}

/**
 * Run the job with safety wrapper.
 */
async function runJob(jobId) {
  const id = jobId || `pay-rec-${Date.now()}`;

  await JobStateManager.markPending({
    jobId: id,
    queue: QUEUE_NAME,
    jobName: JOB_NAME,
    payload: {},
    correlationId: id,
  });

  try {
    const result = await safeWorkerWrapper({
      jobId: id,
      queue: QUEUE_NAME,
      jobName: JOB_NAME,
      payload: {},
      workerId: WORKER_ID,
      correlationId: id,
      processor: () => runReconciliation(),
    });

    return result;
  } catch (err) {
    throw err;
  }
}

// Run immediately on start
runJob();

// Run every 2 minutes
let shuttingDown = false;

process.on('SIGTERM', () => {
  logger.info('Payment reconciliation worker: SIGTERM received');
  shuttingDown = true;
});

const interval = setInterval(async () => {
  if (shuttingDown) {
    clearInterval(interval);
    logger.info('Payment reconciliation worker: shutting down');
    process.exit(0);
  }

  const jobId = `pay-rec-cron-${Date.now()}`;
  await runJob(jobId).catch((err) => {
    logger.error('Payment reconciliation: unhandled error', {
      error: err.message,
      stack: err.stack,
    });
  });
}, RUN_INTERVAL_MS);

module.exports = { runReconciliation, runJob };
