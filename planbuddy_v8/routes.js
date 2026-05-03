'use strict';

const express = require('express');
const authCtrl = require('./controllers/authController');
const bookingCtrl = require('./controllers/bookingController');
const paymentCtrl = require('./controllers/paymentController');
const healthCtrl = require('./controllers/healthController');
const { authLimiter } = require('./middleware/rateLimit');
const { authenticate } = require('./middleware/index');
const { idempotencyMiddleware } = require('./middleware/idempotency');
const { validate } = require('./middleware/validation');
const asyncHandler = require('./utils/asyncHandler'); // assume exists

const router = express.Router();

 // Auth routes (rate limited)
router.post('/auth/login', authLimiter, asyncHandler(authCtrl.login));
router.post('/auth/register', authLimiter, asyncHandler(authCtrl.register));
router.post('/auth/refresh', authLimiter, asyncHandler(authCtrl.refreshToken));
router.post('/auth/logout', authenticate, asyncHandler(authCtrl.logout));

 // Booking (auth + idempotency)
router.post('/bookings', authenticate, idempotencyMiddleware, asyncHandler(bookingCtrl.createBooking));
router.get('/bookings', authenticate, asyncHandler(bookingCtrl.getUserBookings));

 // Payment (auth + idempotency)
router.post('/payment/create-order', authenticate, idempotencyMiddleware, asyncHandler(paymentCtrl.createOrder));
router.post('/payment/verify-payment', authenticate, idempotencyMiddleware, asyncHandler(paymentCtrl.verifyPayment));
router.post('/payment/webhook/razorpay', asyncHandler(paymentCtrl.razorpayWebhook)); // no auth

router.get('/health', asyncHandler(healthCtrl.ready));

module.exports = router;
