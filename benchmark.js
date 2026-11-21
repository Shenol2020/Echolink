const http = require('http');
const { WebSocket } = require('ws');

const BASE       = process.env.BENCH_URL || 'http://localhost:3000';
const WS_BASE    = BASE.replace(/^http/, 'ws') + '/ws';
const DURATION_S = Number(process.env.BENCH_DURATION) || 10;
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS) || 100;

console.log(`\n=== EchoLink Load Test ===`);
console.log(`Target:      ${BASE}`);
console.log(`WS Target:   ${WS_BASE}`);
console.log(`Duration:    ${DURATION_S}s`);
console.log(`Connections: ${CONNECTIONS}\n`);

async function runAutocannonIfAvailable() {
  try {
    const autocannon = require('autocannon');
    console.log('--- Autocannon HTTP Benchmark ---');
    const result = await autocannon({
      url: `${BASE}/config`,
      connections: 50,
      duration: DURATION_S,
    });
    console.log(`Requests/sec: ${result.requests.average}`);
    console.log(`Latency avg:  ${result.latency.average} ms`);
    console.log(`2xx/3xx:      ${result['2xx']}`);
    console.log(`Non-2xx:      ${result.non2xx}`);
  } catch {
    console.log('[autocannon not installed, running built-in benchmark]');
    await benchmarkHTTP();
  }
}

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const req = http.get(`${BASE}${path}`, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, latency: Date.now() - start, bytes: body.length }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function benchmarkHTTP() {
  console.log('--- HTTP Benchmark ---');
  const paths = ['/config', '/phone', '/qrcode.min.js', '/api/sections'];

  for (const p of paths) {
    const latencies = [];
    let errors = 0;
    const end = Date.now() + Math.min(DURATION_S, 5) * 1000;
    while (Date.now() < end) {
      try {
        const r = await httpGet(p);
        latencies.push(r.latency);
      } catch {
        errors++;
      }
    }
    latencies.sort((a, b) => a - b);
    const durSec = Math.max(1, (end - (Date.now() - Math.min(DURATION_S, 5) * 1000)) / 1000);
    const rps = latencies.length / durSec;
    const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
    const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
    const avg = latencies.reduce((s, v) => s + v, 0) / (latencies.length || 1);
    console.log(`  ${p}: ${latencies.length} reqs (${rps.toFixed(0)} rps) avg=${avg.toFixed(1)}ms p50=${p50}ms p99=${p99}ms errors=${errors}`);
  }
}

async function benchmarkWebSocket() {
  console.log('\n--- WebSocket Benchmark ---');
  const sockets = [];
  let connected = 0;
  let messages = 0;
  let errors = 0;

  const connectPromises = [];
  for (let i = 0; i < CONNECTIONS; i++) {
    connectPromises.push(new Promise((resolve) => {
      try {
        const ws = new WebSocket(WS_BASE);
        ws.on('open', () => {
          connected++;
          ws.send(JSON.stringify({ type: 'phone-join', sectionId: 1 }));
          sockets.push(ws);
          resolve();
        });
        ws.on('message', () => { messages++; });
        ws.on('error', () => { errors++; resolve(); });
        ws.on('close', () => {});
        setTimeout(() => resolve(), 5000);
      } catch {
        errors++;
        resolve();
      }
    }));
  }

  await Promise.all(connectPromises);
  console.log(`  Connected: ${connected}/${CONNECTIONS} (errors: ${errors})`);
  console.log(`  Messages received during connect: ${messages}`);

  const startMsgs = messages;
  await new Promise((r) => setTimeout(r, DURATION_S * 1000));
  const endMsgs = messages;
  console.log(`  Messages received during ${DURATION_S}s hold: ${endMsgs - startMsgs}`);

  for (const ws of sockets) {
    try { ws.close(); } catch {}
  }

  await new Promise((r) => setTimeout(r, 1000));
  console.log(`  Total messages: ${messages}`);
  console.log(`  Throughput: ${((endMsgs - startMsgs) / DURATION_S).toFixed(1)} msg/s`);
}

async function main() {
  try {
    await httpGet('/config');
  } catch {
    console.error('ERROR: Server not running at', BASE);
    console.error('Start the server first: npm start');
    process.exit(1);
  }

  await runAutocannonIfAvailable();
  await benchmarkWebSocket();

  console.log('\n=== Benchmark Complete ===\n');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

