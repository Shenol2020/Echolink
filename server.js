require('dotenv').config();

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

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

const REDIS_CHANNEL = 'crowd-lights';
const INSTANCE_ID   = crypto.randomBytes(8).toString('hex') + Date.now().toString(36);

let parsedPublicUrl = null;
try {
  parsedPublicUrl = new URL(PUBLIC_URL);
} catch (e) {
  console.error('[FATAL] Invalid PUBLIC_URL:', PUBLIC_URL);
  process.exit(1);
}

const RATE_LIMIT_WINDOW_SEC = 60;
const MAX_ATTEMPTS = 5;
const LOCKOUT_SEC = 300;
const localLoginAttempts = new Map();

async function checkRateLimit(ip) {
  if (redisData && redisData.status === 'ready') {
    const key = `echolink:ratelimit:${ip}`;
    try {
      const data = await redisData.hgetall(key);
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
  if (redisData && redisData.status === 'ready') {
    const key = `echolink:ratelimit:${ip}`;
    try {
      const now = Date.now();
      const count = await redisData.hincrby(key, 'count', 1);
      if (count === 1) {
        await redisData.expire(key, RATE_LIMIT_WINDOW_SEC);
      }
      if (count >= MAX_ATTEMPTS) {
        const lockedUntil = now + (LOCKOUT_SEC * 1000);
        await redisData.hset(key, 'lockedUntil', String(lockedUntil));
        await redisData.expire(key, LOCKOUT_SEC);
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
  if (redisData && redisData.status === 'ready') {
    try {
      await redisData.del(`echolink:ratelimit:${ip}`);
    } catch (e) {
      console.error('[ratelimit redis reset error]', e.message);
    }
  }
  localLoginAttempts.delete(ip);
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of localLoginAttempts.entries()) {
    if (entry.lockedUntil < now && now - entry.firstAttempt > RATE_LIMIT_WINDOW_SEC * 1000) {
      localLoginAttempts.delete(ip);
    }
  }
}, 60000);

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function signToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() >= payload.exp) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach((cookie) => {
    const [name, ...rest] = cookie.split('=');
    const trimmed = name?.trim();
    if (trimmed) list[trimmed] = decodeURIComponent(rest.join('=').trim());
  });
  return list;
}

function isRequestSecure(req) {
  if (req.socket.encrypted === true) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (proto) {
    const firstProto = proto.split(',')[0].trim().toLowerCase();
    if (firstProto === 'https') return true;
  }
  const arrSsl = req.headers['x-arr-ssl'];
  if (arrSsl) return true;
  return false;
}

function buildAuthCookie(token, isSecure) {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=86400'];
  if (isSecure) {
    flags.push('Secure');
  }
  return `echolink_auth=${token}; ${flags.join('; ')}`;
}

function sanitizeRedirect(target) {
  if (typeof target !== 'string') return '/dashboard';
  const trimmed = target.trim();
  if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.includes('\\') && !trimmed.includes(':')) {
    return trimmed;
  }
  return '/dashboard';
}

function isOriginAllowed(originHeader, reqHost) {
  if (!originHeader) return true;
  let originUrl;
  try {
    originUrl = new URL(originHeader);
  } catch {
    return false;
  }

  if (originUrl.host === parsedPublicUrl.host) return true;
  if (reqHost && originUrl.host === reqHost) return true;

  const originHostname = originUrl.hostname.toLowerCase();
  if (originHostname === 'localhost' || originHostname === '127.0.0.1' || originHostname === '::1') {
    return true;
  }

  return false;
}

let redisPub  = null;
let redisSub  = null;
let redisData = null;

if (REDIS_URL) {
  const Redis = require('ioredis');

  function getRedisOptions(url, role) {
    const isTls = url.startsWith('rediss://');
    const options = {
      retryStrategy: (times) => Math.min(times * 150, 3000),
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
      lazyConnect: false,
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
  });

  redisData.on('ready', async () => {
    console.log('[redis] connected and ready, synchronizing state...');
    await loadStateFromRedis();
    broadcastTelemetry();
  });

  redisSub.on('message', (_channel, raw) => {
    let envelope;
    try { envelope = JSON.parse(raw); } catch { return; }
    deliverLocally(envelope);
  });

  console.log('[redis] connecting…');
} else {
  console.log('[redis] REDIS_URL not set — running single-instance mode (no Redis).');
}

function publish(envelope) {
  if (redisPub && redisPub.status === 'ready') {
    redisPub.publish(REDIS_CHANNEL, JSON.stringify(envelope));
  } else {
    deliverLocally(envelope);
  }
}

const state = {
  sectionCount: 0,
  sections: new Map(),
};
const operators      = new Set();
const instanceCounts = new Map();
const INSTANCE_HEARTBEAT_TTL_MS = 15000;

function makeSectionName(id, total) {
  const fourWay = ['Front', 'Rear', 'Left', 'Right'];
  if (total === 4) return fourWay[id - 1];
  if (total === 2) return id === 1 ? 'Left' : 'Right';
  return `Section ${id}`;
}

function resetSections(count) {
  state.sectionCount = count;
  state.sections.clear();
  for (let i = 1; i <= count; i++) {
    state.sections.set(i, {
      id: i,
      name: makeSectionName(i, count),
      clients: new Set(),
      lastColor: '#000000',
    });
  }
}

async function saveSectionsToRedis() {
  if (!redisData || redisData.status !== 'ready') return;
  try {
    const pipeline = redisData.pipeline();
    pipeline.set('echolink:section_count', String(state.sectionCount));
    pipeline.del('echolink:sections');
    for (const s of state.sections.values()) {
      pipeline.hset('echolink:sections', String(s.id), JSON.stringify({
        id: s.id,
        name: s.name,
        lastColor: s.lastColor,
      }));
    }
    await pipeline.exec();
  } catch (err) {
    console.error('[redis save error]', err.message);
  }
}

async function loadStateFromRedis() {
  if (!redisData || redisData.status !== 'ready') return;
  try {
    const countStr = await redisData.get('echolink:section_count');
    if (!countStr) return;
    const count = parseInt(countStr, 10);
    if (!count || count < 1) return;
    const sectionsHash = await redisData.hgetall('echolink:sections');
    state.sectionCount = count;
    state.sections.clear();
    for (let i = 1; i <= count; i++) {
      let secData = null;
      if (sectionsHash && sectionsHash[String(i)]) {
        try { secData = JSON.parse(sectionsHash[String(i)]); } catch {}
      }
      state.sections.set(i, {
        id: i,
        name: secData?.name || makeSectionName(i, count),
        clients: new Set(),
        lastColor: secData?.lastColor || '#000000',
      });
    }
    console.log(`[redis] loaded ${count} sections from shared state`);
    sendToOperators({ type: 'sections-ready', count, sections: sectionSummary() });
  } catch (err) {
    console.error('[redis load error]', err.message);
  }
}

function pruneStaleInstances() {
  const now = Date.now();
  let changed = false;
  for (const [id, data] of instanceCounts.entries()) {
    if (id !== INSTANCE_ID && (now - data.lastSeen > INSTANCE_HEARTBEAT_TTL_MS)) {
      instanceCounts.delete(id);
      changed = true;
    }
  }
  return changed;
}

function getLocalCounts() {
  const counts = {};
  for (const s of state.sections.values()) {
    counts[s.id] = s.clients.size;
  }
  return counts;
}

function getGlobalConnectedCount(sectionId) {
  if (!redisPub) {
    const sec = state.sections.get(sectionId);
    return sec ? sec.clients.size : 0;
  }
  pruneStaleInstances();
  let total = 0;
  for (const data of instanceCounts.values()) {
    total += ((data.counts && data.counts[sectionId]) || 0);
  }
  return total;
}

function sectionSummary() {
  return Array.from(state.sections.values()).map((s) => ({
    id: s.id,
    name: s.name,
    connected: getGlobalConnectedCount(s.id),
    lastColor: s.lastColor,
  }));
}

function broadcastTelemetry() {
  const localCounts = getLocalCounts();
  instanceCounts.set(INSTANCE_ID, { counts: localCounts, lastSeen: Date.now() });
  if (redisPub) {
    publish({
      target: 'telemetry',
      instanceId: INSTANCE_ID,
      counts: localCounts,
      timestamp: Date.now(),
    });
  }
  sendToOperators({ type: 'section-update', sections: sectionSummary() });
}

setInterval(() => {
  if (pruneStaleInstances()) {
    sendToOperators({ type: 'section-update', sections: sectionSummary() });
  }
  if (redisPub) {
    broadcastTelemetry();
  }
}, 5000);

function deliverLocally(envelope) {
  if (envelope.target === 'operators') {
    sendToOperators(envelope.payload);
  } else if (envelope.target === 'section') {
    const section = state.sections.get(Number(envelope.sectionId));
    if (section && envelope.payload && envelope.payload.type === 'color') {
      section.lastColor = envelope.payload.color;
    }
    sendToSection(envelope.sectionId, envelope.payload);
  } else if (envelope.target === 'allSections') {
    if (envelope.payload && envelope.payload.type === 'color') {
      for (const s of state.sections.values()) s.lastColor = envelope.payload.color;
    }
    for (const id of state.sections.keys()) sendToSection(id, envelope.payload);
  } else if (envelope.target === 'sync-sections') {
    if (envelope.sourceId !== INSTANCE_ID) {
      state.sectionCount = envelope.count;
      state.sections.clear();
      if (Array.isArray(envelope.sections)) {
        for (const s of envelope.sections) {
          state.sections.set(s.id, {
            id: s.id,
            name: s.name,
            clients: new Set(),
            lastColor: s.lastColor || '#000000',
          });
        }
      } else {
        resetSections(envelope.count);
      }
    }
    sendToOperators({ type: 'sections-ready', count: envelope.count, sections: sectionSummary() });
  } else if (envelope.target === 'telemetry') {
    if (envelope.instanceId && envelope.counts) {
      instanceCounts.set(envelope.instanceId, {
        counts: envelope.counts,
        lastSeen: envelope.timestamp || Date.now(),
      });
      sendToOperators({ type: 'section-update', sections: sectionSummary() });
    }
  }
}

function sendToOperators(msg) {
  const payload = JSON.stringify(msg);
  for (const op of operators) {
    if (op.readyState === op.OPEN) op.send(payload);
  }
}

function sendToSection(sectionId, msg) {
  const section = state.sections.get(sectionId);
  if (!section) return;
  const payload = JSON.stringify(msg);
  for (const client of section.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

function broadcastToSection(sectionId, msg) {
  publish({ target: 'section', sectionId, payload: msg });
}

function broadcastToAllSections(msg) {
  publish({ target: 'allSections', payload: msg });
}

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '127.0.0.1';
  const isSecure = isRequestSecure(req);

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/qrcode.min.js') {
    serveFile(res, path.join(__dirname, 'public', 'qrcode.min.js'));
    return;
  }

  if (url.pathname === '/login') {
    serveFile(res, path.join(__dirname, 'public', 'login.html'));
    return;
  }

  if (url.pathname === '/api/login' && req.method === 'POST') {
    const rateCheck = await checkRateLimit(clientIp);
    if (!rateCheck.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        message: `Too many failed attempts. Locked for ${rateCheck.remainingSec}s.`,
      }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      let data = {};
      try { data = JSON.parse(body); } catch {}
      if (safeCompare(data.password, OPERATOR_PASSWORD)) {
        await resetLoginRateLimit(clientIp);
        const token = signToken({ role: 'operator', exp: Date.now() + 24 * 3600 * 1000 });
        res.setHeader('Set-Cookie', buildAuthCookie(token, isSecure));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } else {
        await recordLoginFailure(clientIp);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Invalid passcode.' }));
      }
    });
    return;
  }

  if (url.pathname === '/api/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', `echolink_auth=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict${isSecure ? '; Secure' : ''}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  if (url.pathname === '/phone') {
    serveFile(res, path.join(__dirname, 'public', 'phone.html'));
    return;
  }

  if (url.pathname === '/api/sections' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: state.sectionCount, sections: sectionSummary() }));
    return;
  }

  if (url.pathname === '/config') {
    const wsUrl = PUBLIC_URL.replace(/^http/, 'ws') + '/ws';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ wsUrl, publicUrl: PUBLIC_URL }));
    return;
  }

  if (url.pathname === '/' || url.pathname === '/dashboard' || url.pathname === '/control') {
    const cookies = parseCookies(req.headers.cookie);
    const auth = verifyToken(cookies.echolink_auth);
    if (!auth || auth.role !== 'operator') {
      const safeRedirect = sanitizeRedirect(url.pathname);
      res.writeHead(302, { Location: `/login?redirect=${encodeURIComponent(safeRedirect)}` });
      res.end();
      return;
    }
    if (url.pathname === '/control') {
      serveFile(res, path.join(__dirname, 'public', 'control.html'));
    } else {
      serveFile(res, path.join(__dirname, 'public', 'dashboard.html'));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  ws.role       = null;
  ws.sectionId  = null;
  ws.isAlive    = true;
  ws.isOperator = false;

  const originHeader = req.headers.origin;
  const reqHost = req.headers.host;
  const originValid = isOriginAllowed(originHeader, reqHost);
  ws.originValid = originValid;

  const cookies = parseCookies(req.headers.cookie);
  const auth = verifyToken(cookies.echolink_auth);
  if (auth && auth.role === 'operator') {
    if (originValid) {
      ws.isOperator = true;
      ws.role       = 'operator';
    } else {
      console.warn(`[security] Rejected operator privileges for socket from unauthorized origin: ${originHeader}`);
    }
  }

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    if (ws.role === 'operator') {
      operators.delete(ws);
    } else if (ws.role === 'phone' && ws.sectionId != null) {
      const section = state.sections.get(ws.sectionId);
      if (section) {
        section.clients.delete(ws);
        broadcastTelemetry();
      }
    }
  });
});

const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

wss.on('close', () => clearInterval(heartbeatInterval));

function handleMessage(ws, msg) {
  if (msg.token) {
    const auth = verifyToken(msg.token);
    if (auth && auth.role === 'operator') {
      if (ws.originValid !== false) {
        ws.isOperator = true;
        ws.role       = 'operator';
      }
    }
  }

  switch (msg.type) {

    case 'operator-auth': {
      if (ws.isOperator) {
        operators.add(ws);
        ws.send(JSON.stringify({
          type: 'sections-ready',
          count: state.sectionCount,
          sections: sectionSummary(),
        }));
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized: Operator credentials required.' }));
      }
      break;
    }

    case 'init-sections': {
      if (!ws.isOperator) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized: Operator credentials required.' }));
        return;
      }
      const count = Math.max(1, Math.min(50, Number(msg.count) || 0));
      resetSections(count);
      saveSectionsToRedis();
      ws.role = 'operator';
      operators.add(ws);
      publish({ target: 'sync-sections', count, sourceId: INSTANCE_ID, sections: sectionSummary() });
      ws.send(JSON.stringify({ type: 'sections-ready', count, sections: sectionSummary() }));
      break;
    }

    case 'operator-join': {
      if (!ws.isOperator) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized: Operator credentials required.' }));
        return;
      }
      ws.role = 'operator';
      operators.add(ws);
      ws.send(JSON.stringify({
        type: 'sections-ready',
        count: state.sectionCount,
        sections: sectionSummary(),
      }));
      break;
    }

    case 'phone-join': {
      const sectionId = Number(msg.sectionId);
      const section = state.sections.get(sectionId);
      if (!section) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unknown or unconfigured section.' }));
        return;
      }
      ws.role = 'phone';
      ws.sectionId = sectionId;
      section.clients.add(ws);
      ws.send(JSON.stringify({
        type: 'phone-joined',
        sectionId,
        sectionName: section.name,
        currentColor: section.lastColor,
      }));
      broadcastTelemetry();
      break;
    }

    case 'sync-request': {
      const t2 = Date.now();
      const t3 = Date.now();
      ws.send(JSON.stringify({ type: 'sync-response', t1: msg.t1, t2, t3 }));
      break;
    }

    case 'set-color': {
      if (!ws.isOperator) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized: Operator credentials required.' }));
        return;
      }
      if (Array.isArray(msg.updates)) {
        for (const { sectionId, color } of msg.updates) {
          if (sectionId === 'all') {
            for (const s of state.sections.values()) s.lastColor = color;
            broadcastToAllSections({ type: 'color', color });
          } else {
            const section = state.sections.get(Number(sectionId));
            if (section) {
              section.lastColor = color;
              broadcastToSection(section.id, { type: 'color', color });
            }
          }
        }
      } else {
        const { sectionId, color } = msg;
        if (sectionId === 'all') {
          for (const s of state.sections.values()) s.lastColor = color;
          broadcastToAllSections({ type: 'color', color });
        } else {
          const section = state.sections.get(Number(sectionId));
          if (section) {
            section.lastColor = color;
            broadcastToSection(section.id, { type: 'color', color });
          }
        }
      }
      saveSectionsToRedis();
      sendToOperators({ type: 'section-update', sections: sectionSummary() });
      break;
    }

    case 'scheduled-command': {
      if (!ws.isOperator) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized: Operator credentials required.' }));
        return;
      }
      const leadMs = Math.max(100, Math.min(5000, Number(msg.leadMs) || 500));
      const targetTime = Date.now() + leadMs;
      const sectionColors = msg.sectionColors || {};

      const sendTo = (sectionId) => {
        const command = Object.assign({}, msg.command);
        if (sectionColors[sectionId]) {
          command.color = sectionColors[sectionId];
          if (!command.colorA) command.colorA = sectionColors[sectionId];
        }
        broadcastToSection(sectionId, { type: 'scheduled', command, targetTime });
      };

      if (msg.targets === 'all') {
        for (const id of state.sections.keys()) sendTo(id);
      } else if (Array.isArray(msg.targets)) {
        for (const id of msg.targets) sendTo(Number(id));
      }
      break;
    }

    default:
      break;
  }
}

server.listen(PORT, () => {
  console.log(`Wristband server running`);
  console.log(`  Local:         http://localhost:${PORT}`);
  console.log(`  Public URL:    ${PUBLIC_URL}`);
});
