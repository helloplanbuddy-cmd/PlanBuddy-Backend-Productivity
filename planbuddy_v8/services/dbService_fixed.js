'use strict';

const db = require('../config/db');

module.exports = {
  atomicBookingTransaction: async (params) => {
    // Stub - return mock
    return { existing: false, booking: { id: 'stub', status: 'pending' } };
  },
  cancelBooking: async (id) => ({ id, status: 'cancelled' }),
  reconcilePaymentCaptured: async () => ({ recovered: true }),
};


