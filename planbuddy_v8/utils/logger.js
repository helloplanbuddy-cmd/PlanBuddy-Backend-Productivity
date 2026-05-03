'use strict';

const pino = require('pino')({ level: process.env.LOG_LEVEL || 'info' });
module.exports = pino;
