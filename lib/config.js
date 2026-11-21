require('dotenv').config();

const crypto = require('crypto');

const PORT              = process.env.PORT || 3000;
const PUBLIC_URL        = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const REDIS_URL         = process.env.REDIS_URL || '';
const OPERATOR_PASSWORD = process.env.OPERATOR_PASSWORD;
if (!OPERATOR_PASSWORD) {
  console.error('[FATAL] OPERATOR_PASSWORD environment variable is required.');
  process.exit(1);
}

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || typeof SESSION_SECRET !== 'string' || SESSION_SECRET.length < 32) {
  console.error('[FATAL] SESSION_SECRET environment variable is required and must be at least 32 characters long.');
  process.exit(1);
}

let parsedPublicUrl = null;
try {
  parsedPublicUrl = new URL(PUBLIC_URL);
} catch (e) {
  console.error('[FATAL] Invalid PUBLIC_URL:', PUBLIC_URL);
  process.exit(1);
}

const REDIS_CHANNEL            = 'crowd-lights';
const INSTANCE_ID              = crypto.randomBytes(8).toString('hex') + Date.now().toString(36);
const WS_HEARTBEAT_MS          = Number(process.env.WS_HEARTBEAT_MS) || 30000;
const WS_MAX_PAYLOAD           = Number(process.env.WS_MAX_PAYLOAD) || 16384;
const INSTANCE_HEARTBEAT_TTL_MS = 15000;
const RATE_LIMIT_WINDOW_SEC    = 60;
const MAX_ATTEMPTS             = 5;
const LOCKOUT_SEC              = 300;
const MAX_BUFFERED_AMOUNT      = 65536;

module.exports = {
  PORT,
  PUBLIC_URL,
  REDIS_URL,
  OPERATOR_PASSWORD,
  SESSION_SECRET,
  parsedPublicUrl,
  REDIS_CHANNEL,
  INSTANCE_ID,
  WS_HEARTBEAT_MS,
  WS_MAX_PAYLOAD,
  INSTANCE_HEARTBEAT_TTL_MS,
  RATE_LIMIT_WINDOW_SEC,
  MAX_ATTEMPTS,
  LOCKOUT_SEC,
  MAX_BUFFERED_AMOUNT,
};

