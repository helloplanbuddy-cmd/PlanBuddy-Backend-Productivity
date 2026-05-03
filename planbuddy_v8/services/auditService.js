'use strict';

const logger = require('../utils/logger');

const AuditService = {
  ACTIONS: {
    USER_LOGIN: 'user_login',
    USER_REGISTERED: 'user_registered',
  },
  log: (data) => logger.info('Audit', data)
};

module.exports = AuditService;
