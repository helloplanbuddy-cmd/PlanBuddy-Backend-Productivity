'use strict';

/**
 * middleware/validation.js — Zod Request Validator (v3.0)
 *
 * Classification: ✅ KEEP — logic was correct in v2.0.
 * UPGRADE: Forwards ZodError directly to next(err) — the v3.0 errorHandler
 * now handles ZodError natively and produces the structured { validationErrors }
 * array, so we don't need to normalise here.
 *
 * Usage:
 *   const { validate } = require('../middleware/validation');
 *   const { z } = require('zod');
 *
 *   const CreateBookingSchema = z.object({
 *     tripId:    z.string().uuid(),
 *     startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
 *     groupSize: z.number().int().min(1).max(20),
 *   });
 *
 *   router.post('/', authenticate, validate(CreateBookingSchema), bookingCtrl.create);
 *
 * Validates req.body by default. Pass { query: Schema } or { params: Schema }
 * to validate other parts of the request.
 */

const { ZodError } = require('zod');

/**
 * Validate req.body (default), req.query, or req.params against a Zod schema.
 *
 * @param {import('zod').ZodSchema} schema
 * @param {'body'|'query'|'params'} [source='body']
 * @returns Express middleware
 */
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      // Forward ZodError to the global error handler which normalises it
      return next(result.error);
    }

    // Replace the source with the parsed (and coerced) data
    req[source] = result.data;
    next();
  };
}

/**
 * Validate multiple sources in one middleware call.
 * Useful when a route needs both body and params validated.
 *
 * @param {{ body?: ZodSchema, query?: ZodSchema, params?: ZodSchema }} schemas
 * @returns Express middleware
 */
function validateAll(schemas) {
  return (req, res, next) => {
    for (const [source, schema] of Object.entries(schemas)) {
      const result = schema.safeParse(req[source]);
      if (!result.success) return next(result.error);
      req[source] = result.data;
    }
    next();
  };
}

module.exports = { validate, validateAll };
