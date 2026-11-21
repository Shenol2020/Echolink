require('dotenv').config();

const cluster = require('cluster');
const os = require('os');

const WORKER_COUNT = Number(process.env.WEB_CONCURRENCY) || os.cpus().length;

if (cluster.isPrimary) {
  console.log(`[cluster] Primary ${process.pid} starting ${WORKER_COUNT} workers…`);

  for (let i = 0; i < WORKER_COUNT; i++) {
    cluster.fork({ _CLUSTER_WORKER: '1' });
  }

  cluster.on('online', (worker) => {
    console.log(`[cluster] Worker ${worker.process.pid} online`);
  });

  cluster.on('exit', (worker, code, signal) => {
    console.error(`[cluster] Worker ${worker.process.pid} exited (code=${code}, signal=${signal}). Restarting in 2s…`);
    setTimeout(() => {
      cluster.fork({ _CLUSTER_WORKER: '1' });
    }, 2000);
  });

  process.on('SIGTERM', () => {
    console.log('[cluster] SIGTERM — shutting down all workers…');
    for (const id in cluster.workers) {
      cluster.workers[id].process.kill('SIGTERM');
    }
    setTimeout(() => process.exit(0), 12000);
  });

  process.on('SIGINT', () => {
    console.log('[cluster] SIGINT — shutting down all workers…');
    for (const id in cluster.workers) {
      cluster.workers[id].process.kill('SIGINT');
    }
    setTimeout(() => process.exit(0), 12000);
  });

} else {
  const { server } = require('./server');
  const config = require('./lib/config');

  server.listen(config.PORT, () => {
    console.log(`[cluster] Worker ${process.pid} listening on port ${config.PORT}`);
  });
}

