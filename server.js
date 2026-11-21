require('dotenv').config();

const http = require('http');
const { WebSocketServer } = require('ws');
const config = require('./lib/config');
const { verifyToken, parseCookies, isOriginAllowed } = require('./lib/auth');
const ratelimit = require('./lib/ratelimit');
const redisModule = require('./lib/redis');
const stateModule = require('./lib/state');
const { handleRequest } = require('./lib/routes');
const { handleMessage } = require('./lib/ws-handler');

ratelimit.setRedisClient(null);

redisModule.initRedis(
  (envelope) => stateModule.deliverLocally(envelope),
  async () => {
    ratelimit.setRedisClient(redisModule.getRedisData());
    await stateModule.loadStateFromRedis();
    stateModule.broadcastTelemetry();
  }
);

if (!redisModule.hasRedis()) {
  console.log('[redis] REDIS_URL not set — running single-instance mode (no Redis).');
}

const telemetryInterval = setInterval(() => {
  if (stateModule.pruneStaleInstances()) {
    stateModule.sendToOperators({ type: 'section-update', sections: stateModule.sectionSummary() });
  }
  if (redisModule.hasRedis()) {
    stateModule.broadcastTelemetry();
  }
}, 5000);

const server = http.createServer((req, res) => {
  handleRequest(req, res);
});

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: config.WS_MAX_PAYLOAD,
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const originHeader = req.headers.origin;
  const reqHost = req.headers.host;
  const originValid = isOriginAllowed(originHeader, reqHost);

  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.echolink_auth || url.searchParams.get('token');
  const auth = verifyToken(token);
  const isOperator = !!(auth && auth.role === 'operator' && originValid);

  if (auth && auth.role === 'operator' && !originValid) {
    console.warn(`[security] Rejected operator privileges for socket from unauthorized origin: ${originHeader}`);
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.originValid = originValid;
    ws.isOperator  = isOperator;
    ws.role        = isOperator ? 'operator' : null;
    ws.sectionId   = null;
    ws.isAlive     = true;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    if (ws.role === 'operator') {
      stateModule.operators.delete(ws);
      redisModule.unsubscribeRoom('operators');
    } else if (ws.role === 'phone' && ws.sectionId != null) {
      const section = stateModule.state.sections.get(ws.sectionId);
      if (section) {
        section.clients.delete(ws);
        redisModule.unsubscribeRoom(`section:${ws.sectionId}`);
        stateModule.broadcastTelemetry();
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
}, config.WS_HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeatInterval));

function gracefulShutdown(signal) {
  console.log(`\n[shutdown] ${signal} received, shutting down gracefully…`);

  clearInterval(heartbeatInterval);
  clearInterval(telemetryInterval);
  ratelimit.clearCleanupInterval();

  for (const ws of wss.clients) {
    try {
      ws.close(1001, 'Server shutting down');
    } catch {}
  }

  wss.close(() => {
    server.close(() => {
      redisModule.closeAll().then(() => {
        console.log('[shutdown] Complete.');
        process.exit(0);
      });
    });
  });

  setTimeout(() => {
    console.error('[shutdown] Forced exit after timeout.');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

if (!module.parent && !process.env._CLUSTER_WORKER) {
  server.listen(config.PORT, () => {
    console.log(`Wristband server running`);
    console.log(`  Local:         http://localhost:${config.PORT}`);
    console.log(`  Public URL:    ${config.PUBLIC_URL}`);
  });
}

module.exports = { server, wss };
