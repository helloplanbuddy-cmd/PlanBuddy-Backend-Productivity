'use strict';

const express = require('express');
const authCtrl = require('./controllers/authController');
const bookingCtrl = require('./controllers/bookingController');
const paymentCtrl = require('./controllers/paymentController');
const healthCtrl = require('./controllers/healthController');
const { authLimiter } = require('./middleware/rateLimit');
const { authenticate, requireRole } = require('./middleware/index');
const idempotencyMiddleware = require('./middleware/idempotency');
const { validate, validateAll } = require('./middleware/validation');
const { CreateBookingSchema, GetBookingsSchema, CancelBookingSchema, CreateOrderSchema, VerifyPaymentSchema, AdminBookingsSchema } = require('./middleware/validation');
const { z } = require('zod');
const asyncHandler = require('./utils/asyncHandler'); // assume exists

const router = express.Router();

 // Auth routes (rate limited)
router.post('/auth/login', authLimiter, asyncHandler(authCtrl.login));
router.post('/auth/register', authLimiter, asyncHandler(authCtrl.register));
router.post('/auth/refresh', authLimiter, asyncHandler(authCtrl.refreshToken));
router.post('/auth/logout', authenticate, asyncHandler(authCtrl.logout));

 // Booking (auth + validation + idempotency)
router.post('/bookings', authenticate, validate(CreateBookingSchema), idempotencyMiddleware, asyncHandler(bookingCtrl.createBooking));
router.get('/bookings', authenticate, validate(GetBookingsSchema, 'query'), asyncHandler(bookingCtrl.getUserBookings));
router.post('/bookings/:bookingId/cancel', authenticate, validateAll({ params: z.object({ bookingId: z.string().uuid() }), body: CancelBookingSchema }), asyncHandler(bookingCtrl.cancelBooking));

 // Payment (auth + validation + idempotency)
router.post('/payment/create-order', authenticate, validate(CreateOrderSchema), idempotencyMiddleware, asyncHandler(paymentCtrl.createOrder));
router.post('/payment/verify-payment', authenticate, validate(VerifyPaymentSchema), idempotencyMiddleware, asyncHandler(paymentCtrl.verifyPayment));
router.post('/payment/webhook/razorpay', asyncHandler(paymentCtrl.razorpayWebhook)); // no auth

 // Admin routes (restricted to admin role)
router.post('/admin/reconcile', authenticate, requireRole('admin'), asyncHandler(paymentCtrl.manualReconcile));
router.get('/admin/bookings', authenticate, requireRole('admin'), validate(AdminBookingsSchema, 'query'), asyncHandler(bookingCtrl.getAllBookings));

router.get('/health', asyncHandler(healthCtrl.ready));
router.get('/health/readiness', asyncHandler(healthCtrl.readiness));

module.exports = router;
