// server.js
// Mobile LED-wristband controller — production-ready build.
//
// Run locally:
//   npm install ws ioredis dotenv
//   cp .env.example .env   # fill in PUBLIC_URL; leave REDIS_URL blank for local
//   node server.js
//
// Environment variables (see .env.example):
//   PUBLIC_URL   The public HTTPS/WSS base URL (e.g. https://your-app.azurewebsites.net)
//   PORT         HTTP port (Azure injects this automatically)
//   REDIS_URL    ioredis connection string for Azure Cache for Redis (optional)

require('dotenv').config();

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT       = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const REDIS_URL = process.env.UPSTASH_REDIS_URL || '';

// ---------------------------------------------------------------------------
// Redis Pub/Sub — optional. When REDIS_URL is set, all cross-instance
// broadcast traffic travels through a shared Redis channel so every
// Node.js instance (behind Azure's load balancer) delivers commands to
// its locally-connected clients.
// ---------------------------------------------------------------------------
const REDIS_CHANNEL = 'crowd-lights';

let redisPub = null; // publishes outbound commands
let redisSub = null; // subscribes and delivers to local WS clients

if (REDIS_URL) {
  const Redis = require('ioredis');

  redisPub = new Redis(REDIS_URL, { tls: { rejectUnauthorized: false } });
  redisSub = new Redis(REDIS_URL, { tls: { rejectUnauthorized: false } });

  redisPub.on('error', (e) => console.error('[redis pub]', e.message));
  redisSub.on('error', (e) => console.error('[redis sub]', e.message));

  redisSub.subscribe(REDIS_CHANNEL, (err) => {
    if (err) console.error('[redis] subscribe failed:', err.message);
    else console.log(`[redis] subscribed to channel "${REDIS_CHANNEL}"`);
  });

  // When any instance publishes a payload, deliver it to THIS instance's clients.
  redisSub.on('message', (_channel, raw) => {
    let envelope;
    try { envelope = JSON.parse(raw); } catch { return; }
    deliverLocally(envelope);
  });

  console.log('[redis] connecting…');
} else {
  console.log('[redis] REDIS_URL not set — running single-instance mode (no Redis).');
}

// Publish a broadcast envelope. In single-instance mode this calls deliverLocally
// directly; in multi-instance mode it goes through Redis so every instance receives it.
function publish(envelope) {
  if (redisPub) {
    redisPub.publish(REDIS_CHANNEL, JSON.stringify(envelope));
  } else {
    deliverLocally(envelope);
  }
}

// Deliver a broadcast envelope to WS clients connected to THIS process.
// Envelope shapes:
//   { target: 'section', sectionId: N, payload: {...} }
//   { target: 'allSections', payload: {...} }
//   { target: 'operators', payload: {...} }
function deliverLocally(envelope) {
  if (envelope.target === 'operators') {
    sendToOperators(envelope.payload);
  } else if (envelope.target === 'section') {
    sendToSection(envelope.sectionId, envelope.payload);
  } else if (envelope.target === 'allSections') {
    for (const id of state.sections.keys()) sendToSection(id, envelope.payload);
  }
}

// ---------------------------------------------------------------------------
// In-memory session state (per-process; operators re-sync on reconnect)
// ---------------------------------------------------------------------------
const state = {
  sectionCount: 0,
  sections: new Map(), // id -> { id, name, clients: Set<ws>, lastColor }
};
const operators = new Set();

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

function sectionSummary() {
  return Array.from(state.sections.values()).map((s) => ({
    id: s.id,
    name: s.name,
    connected: s.clients.size,
    lastColor: s.lastColor,
  }));
}

// Low-level send helpers — only touch local WS clients.
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

// Higher-level helpers that go through Redis when available.
function broadcastToOperators(msg) {
  publish({ target: 'operators', payload: msg });
}

function broadcastToSection(sectionId, msg) {
  publish({ target: 'section', sectionId, payload: msg });
}

function broadcastToAllSections(msg) {
  publish({ target: 'allSections', payload: msg });
}

// ---------------------------------------------------------------------------
// HTTP server — static files + /config endpoint
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

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

const server = http.createServer((req, res) => {
  // CORS header so a separate dev front-end can hit /config.
  res.setHeader('Access-Control-Allow-Origin', '*');

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/' || url.pathname === '/dashboard') {
    serveFile(res, path.join(__dirname, 'public', 'dashboard.html'));
  } else if (url.pathname === '/control') {
    serveFile(res, path.join(__dirname, 'public', 'control.html'));
  } else if (url.pathname === '/phone') {
    serveFile(res, path.join(__dirname, 'public', 'phone.html'));
  } else if (url.pathname === '/api/sections' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: state.sectionCount, sections: sectionSummary() }));

  // /config is fetched by every client page on load.
  // It returns the correct public WebSocket URL so clients don't
  // have to guess from location.host (which breaks behind proxies/CDNs).
  } else if (url.pathname === '/config') {
    const wsUrl = PUBLIC_URL.replace(/^http/, 'ws') + '/ws'; // http->ws, https->wss
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ wsUrl, publicUrl: PUBLIC_URL }));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

// ---------------------------------------------------------------------------
// WebSocket handling
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.role     = null;
  ws.sectionId = null;
  ws.isAlive  = true;

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
        // section-update only needs to go to operators on this instance;
        // other instances track their own local client counts.
        sendToOperators({ type: 'section-update', sections: sectionSummary() });
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
  switch (msg.type) {

    case 'init-sections': {
      const count = Math.max(1, Math.min(50, Number(msg.count) || 0));
      resetSections(count);
      ws.role = 'operator';
      operators.add(ws);
      ws.send(JSON.stringify({ type: 'sections-ready', count, sections: sectionSummary() }));
      break;
    }

    case 'operator-join': {
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
      sendToOperators({ type: 'section-update', sections: sectionSummary() });
      break;
    }

    case 'sync-request': {
      const t2 = Date.now();
      const t3 = Date.now();
      ws.send(JSON.stringify({ type: 'sync-response', t1: msg.t1, t2, t3 }));
      break;
    }

    // set-color now supports per-section colors:
    // msg: { updates: [{ sectionId, color }, ...] } — batch update, one entry per section
    // OR legacy: { sectionId: 'all'|N, color } — single target (kept for compatibility)
    case 'set-color': {
      if (Array.isArray(msg.updates)) {
        // New per-section batch path
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
        // Legacy single-target path
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
      sendToOperators({ type: 'section-update', sections: sectionSummary() });
      break;
    }

    // scheduled-command: targets can carry per-section colors.
    // msg.sectionColors: { [sectionId]: color } — optional map so each section
    // gets its own color baked into the command before broadcast.
    case 'scheduled-command': {
      const leadMs = Math.max(100, Math.min(5000, Number(msg.leadMs) || 500));
      const targetTime = Date.now() + leadMs;
      const sectionColors = msg.sectionColors || {};

      const sendTo = (sectionId) => {
        // Clone the command and inject this section's color if provided.
        const command = Object.assign({}, msg.command);
        if (sectionColors[sectionId]) command.color = sectionColors[sectionId];
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
