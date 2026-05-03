'use strict';

const db = require('../config/db');
const logger = require('../utils/logger');

/**
 * DbService.cancelBooking() — Financial-grade atomic cancellation (PHASE 3)
 * Centralizes ALL cancellation logic with row-level locking and safety checks.
 * Used by controllers, workers, webhooks — single source of truth.
 */
async function reconcilePaymentCaptured(client, paymentId, bookingId) {
  // Payment captured → confirm booking
  await client.query(
    `UPDATE payments SET status = 'captured', updated_at = NOW() WHERE id = $1`,
    [paymentId]
  );

  await client.query(
    `UPDATE bookings 
     SET status = 'confirmed', payment_status = 'paid', confirmed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status != 'confirmed'`,
    [bookingId]
  );

  await client.query(
    `UPDATE bookings 
     SET reconciliation_checked_at = NOW(), last_recovery_attempt = NOW() 
     WHERE id = $1`,
    [bookingId]
  );

  return { recovered: true, action: 'confirmed' };
}

async function reconcilePaymentFailed(client, paymentId, bookingId) {
  await client.query(
    `UPDATE payments SET status = 'failed', updated_at = NOW() WHERE id = $1`,
    [paymentId]
  );

  if (bookingId) {
    await client.query(
      `UPDATE bookings SET status = 'failed', payment_status = 'failed', updated_at = NOW() WHERE id = $1`,
      [bookingId]
    );
  }

  return { recovered: true, action: 'marked_failed' };
}

async function reconcilePaymentRefunded(client, paymentId, bookingId) {
  await client.query(
    `UPDATE payments SET status = 'refunded', updated_at = NOW() WHERE id = $1`,
    [paymentId]
  );

  if (bookingId) {
    await client.query(
      `UPDATE bookings 
       SET payment_status = 'refunded', status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [bookingId]
    );
  }

  return { recovered: true, action: 'synced_refunded' };
}

async function cancelBooking(bookingId, idempotencyKey, reason = '', requestedByUserId = null) {
  if (!idempotencyKey) {
    const err = new Error('Idempotency key required for cancellation');
    err.status = 400;
    err.code = 'IDEMPOTENCY_REQUIRED';
    throw err;
  }

  return db.transaction(async (client) => {
    // 1. DB-level idempotency check FIRST
    const idempotencyResult = await client.query(
      `SELECT status, result 
       FROM booking_requests 
       WHERE idempotency_key = $1 AND booking_id = $2`,
      [idempotencyKey, bookingId]
    );

    if (idempotencyResult.rows.length > 0) {
      const record = idempotencyResult.rows[0];
      if (record.status === 'processed') {
        return JSON.parse(record.result);
      }
    }

    // 2. INSERT pending
    await client.query(
      `INSERT INTO booking_requests (idempotency_key, booking_id, action, status)
       VALUES ($1, $2, 'cancel', 'pending')`,
      [idempotencyKey, bookingId]
    );

    // 3. Acquire locks + cancel (existing logic unchanged)
    const bookingResult = await client.query(
      `SELECT id, trip_id, group_size, status, payment_status FROM bookings WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );

    if (bookingResult.rows.length === 0) {
      await client.query(
        `UPDATE booking_requests SET status = 'failed', result = $1 WHERE idempotency_key = $2`,
        [JSON.stringify({ error: 'BOOKING_NOT_FOUND' }), idempotencyKey]
      );
      const err = new Error('Booking not found');
      err.status = 404;
      throw err;
    }

    const bookingData = bookingResult.rows[0];

    if (bookingData.status === 'cancelled') {
      await client.query(
        `UPDATE booking_requests SET status = 'processed', result = $1 WHERE idempotency_key = $2`,
        [JSON.stringify(bookingData), idempotencyKey]
      );
      return bookingData;
    }

    const tripResult = await client.query(
      `SELECT id, current_bookings, max_group_size FROM trips WHERE id = $1 FOR UPDATE`,
      [bookingData.trip_id]
    );

    if (tripResult.rows.length === 0) {
      const err = new Error('Trip not found');
      err.status = 404;
      throw err;
    }

    const trip = tripResult.rows[0];

    if (bookingData.status === 'pending' && bookingData.payment_status === 'unpaid') {
      await client.query(
        `UPDATE trips SET current_bookings = GREATEST(current_bookings - $1, 0), updated_at = NOW()
         WHERE id = $2 AND current_bookings >= $1`,
        [bookingData.group_size, bookingData.trip_id]
      );
    }

    const result = await client.query(
      `UPDATE bookings SET status = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [bookingId]
    );

    await client.query(
      `UPDATE booking_requests SET status = 'processed', result = $1, processed_at = NOW() WHERE idempotency_key = $2`,
      [JSON.stringify(result.rows[0]), idempotencyKey]
    );

    return result.rows[0];
  });
}

module.exports = {
  cancelBooking,
  reconcilePaymentCaptured,
  reconcilePaymentFailed,
  reconcilePaymentRefunded
};


