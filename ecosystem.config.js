module.exports = {
  apps: [{
    name: 'echolink',
    script: 'server.js',
    instances: 'max',
    exec_mode: 'cluster',
    node_args: '--max-old-space-size=4096',
    env: {
      NODE_ENV: 'production',
    },
    max_memory_restart: '512M',
    watch: false,
    autorestart: true,
    exp_backoff_restart_delay: 1000,
  }],
};

