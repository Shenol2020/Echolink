const crypto = require('crypto');
const { SESSION_SECRET, parsedPublicUrl } = require('./config');

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

module.exports = {
  safeCompare,
  signToken,
  verifyToken,
  parseCookies,
  isRequestSecure,
  buildAuthCookie,
  sanitizeRedirect,
  isOriginAllowed,
};

