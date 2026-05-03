'use strict';

const db = require('./db');
const logger = require('../utils/logger');

/**
 * Unified execution safety layer for ALL business mutations.
 * Enforces global idempotency + service abstraction.
 * 
 * @param {string} idempotencyKey - UUID required
 * @param {Function} fn - (client) => Promise
 * @returns {Promise} result
 */
async function executeWithIdempotency(idempotencyKey, fn) {
  if (!idempotencyKey || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
    throw new Error('Valid idempotency_key UUID required');
  }

  return db.transaction(async (client) => {
    // 1. CHECK booking_requests FIRST
    const check = await client.query(
      `SELECT result FROM booking_requests 
       WHERE idempotency_key = $1 AND result IS NOT NULL`,
      [idempotencyKey]
    );

    if (check.rows.length > 0) {
      logger.info('Idempotency hit', { key: idempotencyKey });
      return JSON.parse(check.rows[0].result);
    }

    // 2. INSERT PENDING record
    await client.query(
      `INSERT INTO booking_requests (idempotency_key, status, created_at)
       VALUES ($1, 'executing', NOW())
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [idempotencyKey]
    );

    // 3. EXECUTE business logic
    const result = await fn(client);

    // 4. STORE result
    await client.query(
      `UPDATE booking_requests 
       SET status = 'completed', result = $1, completed_at = NOW()
       WHERE idempotency_key = $2`,
      [JSON.stringify(result), idempotencyKey]
    );

    return result;
  });
}

module.exports = { executeWithIdempotency };

