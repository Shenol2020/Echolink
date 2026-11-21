const fs   = require('fs');
const path = require('path');
const { PUBLIC_URL, OPERATOR_PASSWORD } = require('./config');
const { safeCompare, signToken, verifyToken, parseCookies, isRequestSecure, buildAuthCookie, sanitizeRedirect } = require('./auth');
const { checkRateLimit, recordLoginFailure, resetLoginRateLimit } = require('./ratelimit');
const { state, sectionSummary } = require('./state');

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

function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '127.0.0.1';
  const isSecure = isRequestSecure(req);

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/qrcode.min.js') {
    serveFile(res, path.join(__dirname, '..', 'public', 'qrcode.min.js'));
    return;
  }

  if (url.pathname === '/login') {
    serveFile(res, path.join(__dirname, '..', 'public', 'login.html'));
    return;
  }

  if (url.pathname === '/api/login' && req.method === 'POST') {
    handleLogin(req, res, clientIp, isSecure);
    return;
  }

  if (url.pathname === '/api/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', `echolink_auth=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict${isSecure ? '; Secure' : ''}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  if (url.pathname === '/phone') {
    serveFile(res, path.join(__dirname, '..', 'public', 'phone.html'));
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
      serveFile(res, path.join(__dirname, '..', 'public', 'control.html'));
    } else {
      serveFile(res, path.join(__dirname, '..', 'public', 'dashboard.html'));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

async function handleLogin(req, res, clientIp, isSecure) {
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
}

module.exports = { handleRequest };

