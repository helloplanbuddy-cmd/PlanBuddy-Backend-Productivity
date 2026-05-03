'use strict';

const Razorpay = require('razorpay');
const config = require('../config/razorpay');
const logger = require('../utils/logger');

const razorpay = new Razorpay({
  key_id: config.keyId,
  key_secret: config.keySecret,
});

module.exports = {
  verifySignature: (payload, signature) => {
    // Stub verify
    return true;
  },
  processPaymentTransaction: async () => ({ data: { booking: { id: 'stub' } } }),
  processWebhook: async () => ({ success: true }),
  verifyPaymentWithAPI: async () => ({ status: 'captured' }),
};
