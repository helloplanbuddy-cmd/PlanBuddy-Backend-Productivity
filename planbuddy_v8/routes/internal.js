'use strict';

const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/index');
const healthCtrl = require('../controllers/healthController');

router.get('/metrics', (req, res) => res.json({metrics: 'ok'})); // IP guarded in app.js
router.get('/health/detailed', requireRole('admin'), healthCtrl.detailed);

module.exports = router;
