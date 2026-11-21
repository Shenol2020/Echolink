const fs = require('fs');
const { REDIS_URL, REDIS_CHANNEL } = require('./config');

let redisPub  = null;
let redisSub  = null;
let redisData = null;

const roomRefs = new Map();
let globalMessageHandler = null;

function getRedisOptions(url, role) {
  const isTls = url.startsWith('rediss://');
  const options = {
    retryStrategy: (times) => Math.min(times * 150, 3000),
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    lazyConnect: false,
    enableAutoPipelining: true,
  };
  if (isTls) {
    const rejectUnauthorized = process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false';
    const tlsOptions = { rejectUnauthorized };
    if (process.env.REDIS_TLS_CA && fs.existsSync(process.env.REDIS_TLS_CA)) {
      tlsOptions.ca = [fs.readFileSync(process.env.REDIS_TLS_CA)];
    }
    if (process.env.REDIS_TLS_SERVERNAME) {
      tlsOptions.servername = process.env.REDIS_TLS_SERVERNAME;
    }
    options.tls = tlsOptions;
  }
  return options;
}

function initRedis(onMessage, onReady) {
  if (!REDIS_URL) {
    console.log('[redis] REDIS_URL not set — running single-instance mode (no Redis).');
    return;
  }

  const Redis = require('ioredis');
  globalMessageHandler = onMessage;

  redisPub  = new Redis(REDIS_URL, getRedisOptions(REDIS_URL, 'pub'));
  redisSub  = new Redis(REDIS_URL, getRedisOptions(REDIS_URL, 'sub'));
  redisData = new Redis(REDIS_URL, getRedisOptions(REDIS_URL, 'data'));

  redisPub.on('error', (e) => console.error('[redis pub]', e.message));
  redisSub.on('error', (e) => console.error('[redis sub]', e.message));
  redisData.on('error', (e) => console.error('[redis data]', e.message));

  redisSub.on('connect', () => {
    redisSub.subscribe(REDIS_CHANNEL, (err) => {
      if (err) console.error('[redis] subscribe failed:', err.message);
      else console.log(`[redis] subscribed to channel "${REDIS_CHANNEL}"`);
    });

    for (const [room, count] of roomRefs.entries()) {
      if (count > 0) {
        redisSub.subscribe(`echolink:room:${room}`);
      }
    }
  });

  redisData.on('ready', () => {
    console.log('[redis] connected and ready, synchronizing state...');
    if (onReady) onReady();
  });

  redisSub.on('message', (_channel, raw) => {
    let envelope;
    try { envelope = JSON.parse(raw); } catch { return; }
    if (globalMessageHandler) globalMessageHandler(envelope);
  });

  console.log('[redis] connecting…');
}

function subscribeRoom(room) {
  const current = roomRefs.get(room) || 0;
  roomRefs.set(room, current + 1);
  if (current === 0 && redisSub && redisSub.status === 'ready') {
    redisSub.subscribe(`echolink:room:${room}`);
  }
}

function unsubscribeRoom(room) {
  const current = roomRefs.get(room) || 0;
  if (current <= 1) {
    roomRefs.delete(room);
    if (redisSub && redisSub.status === 'ready') {
      redisSub.unsubscribe(`echolink:room:${room}`);
    }
  } else {
    roomRefs.set(room, current - 1);
  }
}

function publish(envelope) {
  if (redisPub && redisPub.status === 'ready') {
    redisPub.publish(REDIS_CHANNEL, JSON.stringify(envelope));
    return true;
  }
  return false;
}

function publishRoom(room, envelope) {
  if (redisPub && redisPub.status === 'ready') {
    redisPub.publish(`echolink:room:${room}`, JSON.stringify(envelope));
    return true;
  }
  return false;
}

function getRedisData() { return redisData; }
function getRedisPub() { return redisPub; }
function hasRedis() { return !!REDIS_URL; }

function closeAll() {
  const promises = [];
  if (redisPub)  promises.push(redisPub.quit().catch(() => {}));
  if (redisSub)  promises.push(redisSub.quit().catch(() => {}));
  if (redisData) promises.push(redisData.quit().catch(() => {}));
  return Promise.all(promises);
}

module.exports = {
  initRedis,
  publish,
  publishRoom,
  subscribeRoom,
  unsubscribeRoom,
  getRedisData,
  getRedisPub,
  hasRedis,
  closeAll,
  getRedisOptions,
};

