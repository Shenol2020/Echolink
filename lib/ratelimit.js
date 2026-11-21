const { RATE_LIMIT_WINDOW_SEC, MAX_ATTEMPTS, LOCKOUT_SEC } = require('./config');

const localLoginAttempts = new Map();

let _redisData = null;

function setRedisClient(client) {
  _redisData = client;
}

async function checkRateLimit(ip) {
  if (_redisData && _redisData.status === 'ready') {
    const key = `echolink:ratelimit:${ip}`;
    try {
      const data = await _redisData.hgetall(key);
      const now = Date.now();
      const lockedUntil = Number(data.lockedUntil) || 0;
      if (lockedUntil > now) {
        const remainingSec = Math.ceil((lockedUntil - now) / 1000);
        return { allowed: false, remainingSec };
      }
      return { allowed: true };
    } catch (e) {
      console.error('[ratelimit redis check error]', e.message);
    }
  }

  const now = Date.now();
  let record = localLoginAttempts.get(ip);
  if (!record) {
    record = { count: 0, firstAttempt: now, lockedUntil: 0 };
    localLoginAttempts.set(ip, record);
  }
  if (record.lockedUntil > now) {
    const remainingSec = Math.ceil((record.lockedUntil - now) / 1000);
    return { allowed: false, remainingSec };
  }
  if (now - record.firstAttempt > RATE_LIMIT_WINDOW_SEC * 1000) {
    record.count = 0;
    record.firstAttempt = now;
  }
  return { allowed: true, record };
}

async function recordLoginFailure(ip) {
  if (_redisData && _redisData.status === 'ready') {
    const key = `echolink:ratelimit:${ip}`;
    try {
      const now = Date.now();
      const count = await _redisData.hincrby(key, 'count', 1);
      if (count === 1) {
        await _redisData.expire(key, RATE_LIMIT_WINDOW_SEC);
      }
      if (count >= MAX_ATTEMPTS) {
        const lockedUntil = now + (LOCKOUT_SEC * 1000);
        await _redisData.hset(key, 'lockedUntil', String(lockedUntil));
        await _redisData.expire(key, LOCKOUT_SEC);
      }
      return;
    } catch (e) {
      console.error('[ratelimit redis record error]', e.message);
    }
  }

  const now = Date.now();
  const entry = localLoginAttempts.get(ip);
  if (entry) {
    entry.count++;
    if (entry.count >= MAX_ATTEMPTS) {
      entry.lockedUntil = now + (LOCKOUT_SEC * 1000);
    }
  }
}

async function resetLoginRateLimit(ip) {
  if (_redisData && _redisData.status === 'ready') {
    try {
      await _redisData.del(`echolink:ratelimit:${ip}`);
    } catch (e) {
      console.error('[ratelimit redis reset error]', e.message);
    }
  }
  localLoginAttempts.delete(ip);
}

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of localLoginAttempts.entries()) {
    if (entry.lockedUntil < now && now - entry.firstAttempt > RATE_LIMIT_WINDOW_SEC * 1000) {
      localLoginAttempts.delete(ip);
    }
  }
}, 60000);

function clearCleanupInterval() {
  clearInterval(cleanupInterval);
}

module.exports = {
  setRedisClient,
  checkRateLimit,
  recordLoginFailure,
  resetLoginRateLimit,
  clearCleanupInterval,
};

