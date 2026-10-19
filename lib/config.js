const path = require('path');

const config = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: process.env.PORT || 3000,
  API_PREFIX: '/api',
  DB_URL: process.env.DB_URL || 'file:' + path.join(process.cwd(), 'portal.db'),
  DB_AUTH_TOKEN: process.env.DB_AUTH_TOKEN || undefined,
  MAIL_SCRIPT_URL: process.env.MAIL_SCRIPT_URL || '',
  MAIL_KEY: process.env.MAIL_KEY || '',
  CRON_SECRET: process.env.CRON_SECRET || '',
  APP_NAME: 'PW Analytics Ticket Portal',
  PORTAL_BASE_URL: process.env.PORTAL_BASE_URL || 'http://localhost:3000'
};

module.exports = config;
