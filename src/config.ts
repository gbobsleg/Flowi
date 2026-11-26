'use strict';

require('dotenv').config();

module.exports = {
  PORT: parseInt(process.env.PORT as string, 10) || 3000,
  SUPERVISOR_PIN: process.env.SUPERVISOR_PIN || '1234',
  DATABASE_URL: process.env.DATABASE_URL || 'mysql://flowi_user:flowi@localhost:3306/flowi',
  DEFAULT_QUOTA: parseInt(process.env.DEFAULT_QUOTA as string, 10) || 2,
  MAX_PAUSE_MINUTES: parseInt(process.env.MAX_PAUSE_MINUTES as string, 10) || 15,
  HISTORY_RETENTION_DAYS: parseInt(process.env.HISTORY_RETENTION_DAYS as string, 10) || 30,
  GITHUB_OWNER: process.env.GITHUB_OWNER || '',
  GITHUB_REPO: process.env.GITHUB_REPO || '',
  UPDATE_SCRIPT_PATH: process.env.UPDATE_SCRIPT_PATH || './scripts/update.sh',
  RESTART_COMMAND: process.env.RESTART_COMMAND || 'pm2 restart app-pauses',
  // Widget de signalement Fixi : désactivé si l'une des deux valeurs est vide
  FIXI_WIDGET_URL: process.env.FIXI_WIDGET_URL || '',
  FIXI_API_KEY: process.env.FIXI_API_KEY || '',
};
