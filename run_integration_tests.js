const { spawn } = require('child_process');
const http = require('http');

function checkPortInUse(port, callback) {
  const req = http.get(`http://localhost:${port}/login`, () => {
    callback(true);
  });
  req.on('error', () => {
    callback(false);
  });
  req.setTimeout(500, () => {
    req.destroy();
    callback(false);
  });
}

function runTests(serverProcess) {
  const tests = spawn('node', ['test_suite.js'], {
    cwd: __dirname,
    stdio: 'inherit',
  });

  tests.on('close', (code) => {
    if (serverProcess) {
      serverProcess.kill();
    }
    process.exit(code);
  });
}

checkPortInUse(3000, (inUse) => {
  if (inUse) {
    console.log('[test-runner] Server is already running on port 3000. Running test suite directly...');
    runTests(null);
  } else {
    const server = spawn('node', ['server.js'], {
      cwd: __dirname,
      stdio: 'inherit',
      env: Object.assign({}, process.env, { PORT: '3000' }),
    });

    server.on('error', (err) => {
      console.error('Failed to start server:', err);
      process.exit(1);
    });

    setTimeout(() => {
      runTests(server);
    }, 1500);
  }
});
