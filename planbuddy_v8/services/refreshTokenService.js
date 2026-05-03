'use strict';

const crypto = require('crypto');
const env = require('../config/env');
const { redis } = require('../config/redis');
const logger = console; // stub

const PREFIX = 'refresh:';
const MAX_SESSIONS = env.MAX_SESSION_LIMIT || 5;

async function createRefreshToken(userId, redisClient, metadata = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const data = {
    userId,
    token,
    expiresAt: new Date(Date.now() + parseInt(env.REFRESH_TOKEN_EXPIRY) * 1000),
    metadata,
    revoked: false,
    replacedBy: null,
  };
  await redisClient.setex(`${PREFIX}${token}`, parseInt(env.REFRESH_TOKEN_EXPIRY), JSON.stringify(data));
  return { refreshToken: token };
}

async function rotateRefreshToken(oldToken, redisClient, metadata = {}) {
  const oldDataStr = await redisClient.get(`${PREFIX}${oldToken}`);
  if (!oldDataStr) throw { code: 'INVALID_REFRESH_TOKEN' };
  const oldData = JSON.parse(oldDataStr);
  if (oldData.revoked) throw { code: 'TOKEN_REUSED' };
  if (oldData.userId !== oldData.userId) throw { code: 'TOKEN_REUSE', userId: oldData.userId };

  await redisClient.del(`${PREFIX}${oldToken}`);
  oldData.revoked = true;
  oldData.replacedBy = crypto.randomUUID();

  const newTokenData = await createRefreshToken(oldData.userId, redisClient, metadata);
  return newTokenData;
}

async function revokeAllRefreshTokensForUser(userId, redisClient) {
  const keys = await redisClient.keys(`${PREFIX}*`);
  for (const key of keys) {
    const dataStr = await redisClient.get(key);
    const data = JSON.parse(dataStr);
    if (data.userId === userId) await redisClient.del(key);
  }
}

module.exports = {
  createRefreshToken,
  rotateRefreshToken,
  revokeAllRefreshTokensForUser,
};
