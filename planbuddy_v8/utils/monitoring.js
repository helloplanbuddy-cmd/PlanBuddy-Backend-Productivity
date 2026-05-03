'use strict';

const client = require('prom-client');

// Stub - no Registry constructor issue
module.exports = {
  register: { metrics: () => 'stub' },
  http_requests_total: { inc: () => {} },
  request_duration_ms: { observe: () => {} },
};
