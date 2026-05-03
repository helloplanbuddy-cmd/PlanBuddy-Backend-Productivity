'use strict';

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const db = require('../config/db');
// const logger = require('./logger');

function getRedis() { return require('../config/redis').redis; }

function generateToken(payload) {
  const jti = require('crypto').randomUUID();
  const token = jwt.sign({ ...payload, jti, iat: Math.floor(Date.now() / 1000) }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRY });
  return { token, jti };
}

function verifyToken(token) {
  return jwt.verify(token, env.JWT_SECRET, { clockTolerance: 0 });
}

function decodeToken(token) {
  return jwt.decode(token);
}

async function isRevoked(jti, db, redis) {
  if (!jti) return false;
  if (redis) {
    const cached = await redis.get(`jti:revoked:${jti}`);
    if (cached !== null) return cached === '1';
  }
  const result = await db.query('SELECT 1 FROM token_blacklist WHERE jti = $1 AND expires_at > NOW()', [jti]);
  const revoked = result.rows.length > 0;
  if (redis) redis.set(`jti:revoked:${jti}`, revoked ? '1' : '0', 'EX', env.REDIS_JTI_CACHE_TTL);
  return revoked;
}

async function revokeToken(jti, userId, db, redis) {
  await db.query('INSERT INTO token_blacklist (jti, user_id, expires_at) VALUES ($1, $2, NOW() + $3) ON CONFLICT (jti) DO NOTHING', [jti, userId, env.JWT_EXPIRY]);
  if (redis) await redis.del(`jti:revoked:${jti}`);
}

async function revokeAllUserTokens(userId, db, redis) {
  const result = await db.query('SELECT jti FROM token_blacklist WHERE user_id = $1', [userId]);
  for (const row of result.rows) await redis?.del(`jti:revoked:${row.jti}`);
  await db.query('DELETE FROM token_blacklist WHERE user_id = $1', [userId]);
}

module.exports = { generateToken, verifyToken, decodeToken, isRevoked, revokeToken, revokeAllUserTokens };
