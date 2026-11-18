require('dotenv').config();

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT       = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const REDIS_URL  = process.env.REDIS_URL || '';

const REDIS_CHANNEL = 'crowd-lights';
const INSTANCE_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);

let redisPub = null;
let redisSub = null;

if (REDIS_URL) {
  const Redis = require('ioredis');
  const rejectUnauthorized = process.env.REDIS_TLS_REJECT_UNAUTHORIZED === 'true';

  redisPub = new Redis(REDIS_URL, { tls: { rejectUnauthorized } });
  redisSub = new Redis(REDIS_URL, { tls: { rejectUnauthorized } });

  redisPub.on('error', (e) => console.error('[redis pub]', e.message));
  redisSub.on('error', (e) => console.error('[redis sub]', e.message));

  redisSub.subscribe(REDIS_CHANNEL, (err) => {
    if (err) console.error('[redis] subscribe failed:', err.message);
    else console.log(`[redis] subscribed to channel "${REDIS_CHANNEL}"`);
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
  if (redisPub) {
    redisPub.publish(REDIS_CHANNEL, JSON.stringify(envelope));
  } else {
    deliverLocally(envelope);
  }
}

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
      resetSections(envelope.count);
    }
    sendToOperators({ type: 'sections-ready', count: envelope.count, sections: sectionSummary() });
  }
}

const state = {
  sectionCount: 0,
  sections: new Map(),
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

function broadcastToOperators(msg) {
  publish({ target: 'operators', payload: msg });
}

function broadcastToSection(sectionId, msg) {
  publish({ target: 'section', sectionId, payload: msg });
}

function broadcastToAllSections(msg) {
  publish({ target: 'allSections', payload: msg });
}

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
  } else if (url.pathname === '/config') {
    const wsUrl = PUBLIC_URL.replace(/^http/, 'ws') + '/ws';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ wsUrl, publicUrl: PUBLIC_URL }));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

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
        broadcastToOperators({ type: 'section-update', sections: sectionSummary() });
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
      publish({ target: 'sync-sections', count, sourceId: INSTANCE_ID });
      broadcastToOperators({ type: 'sections-ready', count, sections: sectionSummary() });
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
      broadcastToOperators({ type: 'section-update', sections: sectionSummary() });
      break;
    }

    case 'sync-request': {
      const t2 = Date.now();
      const t3 = Date.now();
      ws.send(JSON.stringify({ type: 'sync-response', t1: msg.t1, t2, t3 }));
      break;
    }

    case 'set-color': {
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
      broadcastToOperators({ type: 'section-update', sections: sectionSummary() });
      break;
    }

    case 'scheduled-command': {
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
