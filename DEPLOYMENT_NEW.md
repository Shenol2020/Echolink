# EchoLink High-Concurrency & Production Deployment Guide

## 1. Operating System & Linux Kernel Tuning

For high-concurrency crowd events handling 10,000 to 50,000+ concurrent spectator WebSocket connections, tune Linux kernel limits:

### Open File Descriptors (`ulimit`)
Each TCP connection consumes one file descriptor. Default limits (1024) will reject connections under crowd load.

Edit `/etc/security/limits.conf`:
```
* soft nofile 65535
* hard nofile 65535
root soft nofile 65535
root hard nofile 65535
```

Verify in your running shell:
```bash
ulimit -n 65535
```

### Kernel Socket and Network Stack Tuning (`sysctl.conf`)
Add the following to `/etc/sysctl.conf` and apply with `sudo sysctl -p`:

```ini
# Maximum socket listen backlog queue for incoming connections
net.core.somaxconn = 4096

# Maximum number of packets queued on the input side
net.core.netdev_max_backlog = 16384

# Expand ephemeral port range to allow maximum outgoing/forwarding connections
net.ipv4.ip_local_port_range = 1024 65535

# Enable TCP SYN cookies to mitigate SYN flood attacks
net.ipv4.tcp_syncookies = 1

# Maximum queue length of incoming TCP connection requests
net.ipv4.tcp_max_syn_backlog = 8192

# Enable reuse of TIME_WAIT sockets for new connections when safe
net.ipv4.tcp_tw_reuse = 1

# Fast FIN timeout to free closed sockets rapidly
net.ipv4.tcp_fin_timeout = 15

# Keepalive timeouts: detect dead connections promptly
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_intvl = 15
net.ipv4.tcp_keepalive_probes = 5

# Maximum memory allocated for TCP buffers (min, default, max in pages)
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216
```

---

## 2. Nginx Reverse Proxy & Static Asset Serving

Deploy Nginx in front of Node.js instances to terminate TLS, offload static assets directly from disk, and forward WebSocket traffic:

```nginx
# Upstream cluster of Node.js worker instances
upstream echolink_backend {
    # ip_hash ensures sticky sessions if needed, or least_conn for connection balancing
    least_conn;
    server 127.0.0.1:3000 max_fails=3 fail_timeout=10s;
    # Add additional worker ports if running multiple standalone processes:
    # server 127.0.0.1:3001;
    # server 127.0.0.1:3002;
    keepalive 64;
}

# Map for WebSocket Upgrade header
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    root /var/www/echolink/public;

    # Static assets served directly by Nginx (bypasses Node.js completely)
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 7d;
        add_header Cache-Control "public, no-transform";
        access_log off;
        try_files $uri =404;
    }

    # Offline QR Code library (high cache lifetime)
    location = /qrcode.min.js {
        expires 30d;
        add_header Cache-Control "public, max-age=2592000, immutable";
        access_log off;
        try_files /qrcode.min.js =404;
    }

    # WebSocket endpoint routing
    location /ws {
        proxy_pass http://echolink_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Disable buffering for real-time WebSocket delivery
        proxy_buffering off;

        # Keep connection open for heartbeat intervals (30s)
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # Dynamic HTTP routes and API proxy
    location / {
        proxy_pass http://echolink_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 3. Node.js Multi-Core Process Management

### Using Built-in Cluster Mode
EchoLink includes a native multi-core clustering entrypoint in `cluster.js`:

```bash
# Starts one worker per available CPU core with 4GB heap per worker
npm run start:cluster
```

Workers automatically restart if an unhandled crash occurs, and SIGTERM/SIGINT signals trigger graceful socket drain and resource cleanup across all workers.

### Using PM2 Process Manager
For production server management with zero-downtime reloads:

```bash
# Install PM2 globally
npm install -g pm2

# Start using the included configuration
npm run start:pm2

# Check status and monitoring
pm2 status
pm2 monit

# Graceful reload across all CPU cores
pm2 reload echolink
```

The included `ecosystem.config.js` sets:
- `instances: 'max'` (automatically forks across all CPU cores)
- `exec_mode: 'cluster'`
- `node_args: '--max-old-space-size=4096'` (prevents out-of-memory under high connection volume)
- `max_memory_restart: '512M'`

---

## 4. Scaling Environment Variables Reference

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `PORT` | `3000` | Port HTTP and WebSocket server listens on. |
| `PUBLIC_URL` | `http://localhost:3000` | Base public URL used in QR codes and CORS/Origin checks. |
| `OPERATOR_PASSWORD` | *(Required)* | Operator access password for `/dashboard` and `/control`. |
| `SESSION_SECRET` | *(Required, >=32 chars)* | Permanent HMAC secret for session token signatures. |
| `REDIS_URL` | *(Optional)* | Azure / Redis connection string (`rediss://...`). |
| `REDIS_CLUSTER_NODES`| *(Optional)* | Comma-separated host:port list for Redis Cluster topologies. |
| `REDIS_TLS_REJECT_UNAUTHORIZED` | `true` | Enforces TLS certificate verification on Redis connections. |
| `WS_HEARTBEAT_MS` | `30000` | WebSocket ping/pong interval (30 seconds). |
| `WS_MAX_PAYLOAD` | `16384` | Max incoming WebSocket frame size (16KB) to prevent DoS. |
| `UV_THREADPOOL_SIZE` | `16` | Libuv thread pool size for crypto hashing and file I/O. |
| `WEB_CONCURRENCY` | `os.cpus().length` | Number of worker processes spawned by `cluster.js`. |

---

## 5. Load Testing & Verification

Run the automated load-testing suite against your deployment:

```bash
# Run HTTP and WebSocket benchmark
npm run benchmark

# Custom benchmark target and duration
BENCH_URL=http://localhost:3000 BENCH_DURATION=15 BENCH_CONNECTIONS=200 npm run benchmark
```
