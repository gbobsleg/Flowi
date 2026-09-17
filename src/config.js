require('dotenv').config();

module.exports = {
  PORT: parseInt(process.env.PORT, 10) || 3000,
  SUPERVISOR_PIN: process.env.SUPERVISOR_PIN || '1234',
  DATABASE_URL: process.env.DATABASE_URL || 'postgres://flowi:flowi@postgres:5432/flowi',
  DEFAULT_QUOTA: parseInt(process.env.DEFAULT_QUOTA, 10) || 2,
  MAX_PAUSE_MINUTES: parseInt(process.env.MAX_PAUSE_MINUTES, 10) || 15,
  HISTORY_RETENTION_DAYS: parseInt(process.env.HISTORY_RETENTION_DAYS, 10) || 30,
  GITHUB_OWNER: process.env.GITHUB_OWNER || '',
  GITHUB_REPO: process.env.GITHUB_REPO || '',
  UPDATE_SCRIPT_PATH: process.env.UPDATE_SCRIPT_PATH || './scripts/update.sh',
  RESTART_COMMAND: process.env.RESTART_COMMAND || 'pm2 restart app-pauses',
};
