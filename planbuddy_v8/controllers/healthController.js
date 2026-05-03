'use strict';

exports.ready = (req, res) => res.json({ status: 'ready' });
exports.detailed = (req, res) => res.json({ status: 'detailed ok' });
