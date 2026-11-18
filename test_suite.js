const http = require('http');
const { WebSocket } = require('ws');

const BASE_URL = 'http://localhost:3000';
const WS_URL = 'ws://localhost:3000/ws';

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function httpRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
        });
      });
    });
    req.on('error', reject);
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

async function runTests() {
  console.log('--- STARTING ECHOLINK INTEGRATION TEST SUITE ---');
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  try {
    // TEST 1: Offline QR Code Library Availability (BUG-12)
    console.log('\n--- 1. Testing Offline QR Library (BUG-12) ---');
    const qrRes = await httpRequest({
      hostname: 'localhost',
      port: 3000,
      path: '/qrcode.min.js',
      method: 'GET',
    });
    assert(qrRes.statusCode === 200, 'GET /qrcode.min.js returns 200 OK');
    assert(qrRes.headers['content-type'].includes('javascript'), 'Content-Type is application/javascript');
    assert(qrRes.body.length > 15000, `QR library loaded locally without CDN (${qrRes.body.length} bytes)`);

    // TEST 2: Unauthenticated Protected Routes (BUG-10)
    console.log('\n--- 2. Testing HTTP Authentication & Protected Routes (BUG-10) ---');
    const dashUnauth = await httpRequest({
      hostname: 'localhost',
      port: 3000,
      path: '/dashboard',
      method: 'GET',
    });
    assert(dashUnauth.statusCode === 302, 'Unauthenticated /dashboard redirects (302)');
    assert(dashUnauth.headers.location.startsWith('/login?redirect=%2Fdashboard'), '/dashboard redirects to /login');

    const controlUnauth = await httpRequest({
      hostname: 'localhost',
      port: 3000,
      path: '/control',
      method: 'GET',
    });
    assert(controlUnauth.statusCode === 302, 'Unauthenticated /control redirects (302)');

    // TEST 2b: Open Redirect Protection (BUG-10)
    console.log('\n--- 2b. Testing Open Redirect Sanitization (BUG-10) ---');
    const openRedir = await httpRequest({
      hostname: 'localhost',
      port: 3000,
      path: '/login?redirect=//evil.com',
      method: 'GET',
    });
    assert(openRedir.statusCode === 200, 'Login page handles redirect parameter gracefully');

    // TEST 3: Login Authentication, Rate Limiting, and Cookie Security
    console.log('\n--- 3. Testing Operator Login Security & Rate Limiting ---');
    const wrongLogin = await httpRequest({
      hostname: 'localhost',
      port: 3000,
      path: '/api/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, JSON.stringify({ password: 'wrongpassword' }));
    assert(wrongLogin.statusCode === 401, 'Wrong password rejected with 401 Unauthorized');

    const correctLogin = await httpRequest({
      hostname: 'localhost',
      port: 3000,
      path: '/api/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, JSON.stringify({ password: 'echolink_admin_2026' }));
    assert(correctLogin.statusCode === 200, 'Correct password accepted with 200 OK');

    const loginData = JSON.parse(correctLogin.body);
    assert(loginData.success === true, 'Response payload has success: true');
    assert(typeof loginData.token === 'string', 'Response provides signed session token');

    const setCookie = correctLogin.headers['set-cookie'] ? correctLogin.headers['set-cookie'][0] : '';
    assert(setCookie.includes('HttpOnly'), 'Session cookie echolink_auth set with HttpOnly');
    assert(setCookie.includes('SameSite=Strict'), 'Session cookie echolink_auth set with SameSite=Strict');

    // TEST 4: Access Protected Route with Cookie
    const authDash = await httpRequest({
      hostname: 'localhost',
      port: 3000,
      path: '/dashboard',
      method: 'GET',
      headers: { Cookie: setCookie },
    });
    assert(authDash.statusCode === 200, 'Authenticated operator can access /dashboard (200 OK)');
    assert(authDash.body.includes('Session Setup') || authDash.body.includes('Crowd Lights'), '/dashboard HTML rendered successfully');

    // TEST 5: Audience Access (Zero Passwords Needed)
    console.log('\n--- 4. Testing Audience Access (Zero Passwords Needed) ---');
    const phoneRes = await httpRequest({
      hostname: 'localhost',
      port: 3000,
      path: '/phone',
      method: 'GET',
    });
    assert(phoneRes.statusCode === 200, 'Spectator opens /phone without login (200 OK)');

    // TEST 6: WebSocket Security & Operator Access
    console.log('\n--- 5. Testing WebSocket Authorization (BUG-10) ---');
    const unauthWs = new WebSocket(WS_URL);
    await new Promise((resolve) => unauthWs.on('open', resolve));

    let unauthRejected = false;
    unauthWs.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'error' && msg.message.includes('Unauthorized')) {
        unauthRejected = true;
      }
    });

    unauthWs.send(JSON.stringify({ type: 'init-sections', count: 4 }));
    await wait(300);
    assert(unauthRejected, 'Unauthenticated socket rejected from running init-sections');

    // Operator WebSocket with Token
    console.log('\n--- 6. Testing Authenticated Operator Operations ---');
    const opWs = new WebSocket(WS_URL);
    await new Promise((resolve) => opWs.on('open', resolve));

    let operatorSectionsReady = false;
    let operatorTelemetry = null;
    opWs.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'sections-ready') operatorSectionsReady = msg;
      if (msg.type === 'section-update') operatorTelemetry = msg;
    });

    opWs.send(JSON.stringify({ type: 'init-sections', count: 4, token: loginData.token }));
    await wait(400);

    assert(operatorSectionsReady !== false, 'Authenticated operator initialized 4 sections');
    assert(operatorSectionsReady.count === 4, 'Section count is 4');
    assert(operatorSectionsReady.sections.length === 4, 'Received 4 section records');

    // TEST 7: Phone Connection and Attendance Tracking
    console.log('\n--- 7. Testing Spectator Connection & Device Counts (BUG-04) ---');
    const phoneWs1 = new WebSocket(WS_URL);
    await new Promise((resolve) => phoneWs1.on('open', resolve));

    let phoneJoined = false;
    phoneWs1.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'phone-joined') phoneJoined = msg;
    });

    phoneWs1.send(JSON.stringify({ type: 'phone-join', sectionId: 1 }));
    await wait(300);

    assert(phoneJoined !== false, 'Phone successfully joined Section 1 without authentication');
    assert(phoneJoined.sectionId === 1, 'Phone confirmed in Section 1');
    assert(operatorTelemetry !== null, 'Operator received section-update on phone join');
    assert(operatorTelemetry.sections[0].connected === 1, 'Operator sees exactly 1 connected device in Section 1');

    // Add 2nd phone to section 1
    const phoneWs2 = new WebSocket(WS_URL);
    await new Promise((resolve) => phoneWs2.on('open', resolve));
    phoneWs2.send(JSON.stringify({ type: 'phone-join', sectionId: 1 }));
    await wait(300);
    assert(operatorTelemetry.sections[0].connected === 2, 'Global device count accurately tracks 2 connected devices');

    // Phone attempts unauthorized lighting command
    let phoneCommandBlocked = false;
    phoneWs1.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'error' && msg.message.includes('Unauthorized')) {
        phoneCommandBlocked = true;
      }
    });
    phoneWs1.send(JSON.stringify({ type: 'set-color', updates: [{ sectionId: 1, color: '#ff0000' }] }));
    await wait(300);
    assert(phoneCommandBlocked, 'Spectator socket strictly prohibited from issuing lighting commands');

    // TEST 8: Disconnect Phone & Telemetry Update
    console.log('\n--- 8. Testing Phone Disconnect & Telemetry Decrement ---');
    phoneWs2.close();
    await wait(300);
    assert(operatorTelemetry.sections[0].connected === 1, 'Device count decrements to 1 after phone disconnection');

    // TEST 9: Lighting Patterns & Scheduled Execution
    console.log('\n--- 9. Testing Lighting Commands & Pattern Delivery ---');
    let scheduledDelivered = null;
    phoneWs1.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'scheduled') scheduledDelivered = msg;
    });

    opWs.send(JSON.stringify({
      type: 'scheduled-command',
      targets: 'all',
      command: { mode: 'strobe', intervalMs: 90, durationMs: 4000 },
      sectionColors: { '1': '#4361ee' },
      leadMs: 500,
      token: loginData.token,
    }));
    await wait(300);

    assert(scheduledDelivered !== null, 'Phone received scheduled pattern packet');
    assert(scheduledDelivered.command.mode === 'strobe', 'Pattern mode is strobe');
    assert(scheduledDelivered.command.color === '#4361ee', 'Injected section color is #4361ee');
    assert(typeof scheduledDelivered.targetTime === 'number', 'Scheduled packet has numeric targetTime');

    // Clean up sockets
    unauthWs.close();
    opWs.close();
    phoneWs1.close();

  } catch (err) {
    console.error('Test error:', err);
    failed++;
  }

  console.log('\n========================================');
  console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================');
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
