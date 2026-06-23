# Azure Deployment Guide — Crowd Lights

This guide takes you from zero to a live production deployment on Azure
using a Student account. Total cost stays within the free/student tier.

---

## What you will create

| Resource | Tier | Cost |
|---|---|---|
| Azure App Service Plan | F1 Free or B1 Basic | Free / ~$13/mo |
| Azure App Service (Node.js) | — | Included in plan |
| Azure Cache for Redis | C0 Basic (250 MB) | ~$16/mo |

> **Student tip:** The Azure for Students credit ($100) covers B1 + C0
> Redis for several months. Use F1 (free) App Service if you want to
> avoid any spend, but note F1 has no custom domain/SSL and sleeps after
> 20 minutes of inactivity — fine for demos, not for a live show.
> For a real event, upgrade to B1 for the day.

---

## Part 1 — Provision Azure Cache for Redis

Redis handles cross-instance broadcast so every Node.js instance
delivers commands to its own locally-connected phones.

### 1.1 Create the cache

1. In the Azure Portal, search **Azure Cache for Redis** → **Create**.
2. Fill in:
   - **Resource group:** create new, e.g. `crowd-lights-rg`
   - **DNS name:** e.g. `crowd-lights-cache` (must be globally unique)
   - **Location:** pick the same region you'll use for the App Service
   - **Cache SKU:** `C0 Basic` (cheapest, enough for this workload)
3. Click **Review + create** → **Create**. Wait ~5 minutes.

### 1.2 Get the connection string

1. Open your new Redis resource → **Access keys** (left sidebar).
2. Copy the **Primary connection string (StackExchange.Redis)** — it
   looks like:
   ```
   crowd-lights-cache.redis.cache.windows.net:6380,password=XXXX,ssl=True,abortConnect=False
   ```
3. Convert it to ioredis format:
   ```
   rediss://:XXXX@crowd-lights-cache.redis.cache.windows.net:6380
   ```
   (Note `rediss://` with double-s for TLS, and `:PASSWORD@` before the host.)

Save this string — you'll paste it into App Service settings in Part 3.

---

## Part 2 — Create the App Service

### 2.1 Create an App Service Plan

1. Search **App Service Plans** → **Create**.
2. Fill in:
   - **Resource group:** `crowd-lights-rg` (same as above)
   - **Name:** e.g. `crowd-lights-plan`
   - **Operating System:** Linux
   - **Region:** same as Redis
   - **Pricing tier:** F1 Free (demo) or B1 Basic (live event)
3. **Review + create** → **Create**.

### 2.2 Create the Web App

1. Search **App Services** → **Create** → **Web App**.
2. Fill in:
   - **Resource group:** `crowd-lights-rg`
   - **Name:** e.g. `crowd-lights` (this becomes `crowd-lights.azurewebsites.net`)
   - **Publish:** Code
   - **Runtime stack:** Node 20 LTS
   - **Operating System:** Linux
   - **Region:** same as above
   - **App Service Plan:** select `crowd-lights-plan`
3. **Review + create** → **Create**.

### 2.3 Enable WebSockets

WebSockets are off by default on Azure App Service.

1. Open your App Service → **Configuration** (left sidebar) →
   **General settings** tab.
2. Set **Web sockets** to **On**.
3. Click **Save**.

---

## Part 3 — Set environment variables

1. Open your App Service → **Configuration** → **Application settings**.
2. Click **New application setting** for each of the following:

| Name | Value |
|---|---|
| `PUBLIC_URL` | `https://crowd-lights.azurewebsites.net` (your actual app name) |
| `REDIS_URL` | `rediss://:XXXX@crowd-lights-cache.redis.cache.windows.net:6380` |

> Do **not** set `PORT` — Azure injects it automatically.

3. Click **Save** → **Continue** (the app will restart).

---

## Part 4 — Deploy the code

### Option A: Deploy via ZIP (quickest for a one-off)

```bash
# On your local machine, inside the project folder:
npm install --omit=dev        # install only production deps
zip -r deploy.zip . \
  --exclude "*.git*" \
  --exclude ".env" \
  --exclude "*.md" \
  --exclude "node_modules/.cache/*"

# Deploy using Azure CLI (install from https://aka.ms/installazurecliwindows)
az login
az webapp deployment source config-zip \
  --resource-group crowd-lights-rg \
  --name crowd-lights \
  --src deploy.zip
```

### Option B: Deploy via GitHub Actions (recommended for ongoing use)

1. Push your project to a GitHub repository.
2. In the Azure Portal → App Service → **Deployment Center**.
3. Choose **GitHub** → authorize → select your repo and branch.
4. Azure auto-generates a GitHub Actions workflow file that builds and
   deploys on every push to that branch.

### Option C: Deploy via VS Code

Install the **Azure App Service** extension in VS Code, right-click your
project folder → **Deploy to Web App**, pick `crowd-lights`.

---

## Part 5 — Verify the deployment

1. Open `https://crowd-lights.azurewebsites.net/` — you should see the
   session setup dashboard.
2. Open browser DevTools → Network → filter by WS. You should see a
   WebSocket connection to `wss://crowd-lights.azurewebsites.net/ws`.
3. Set section count to 2 and click Generate. Two QR codes should appear,
   each encoding a `https://…` URL (not `localhost`).
4. Scan one QR code on your phone. Check the phone screen shows
   "Section 1" or similar and "synced · offset Xms".

### Common issues

| Symptom | Fix |
|---|---|
| App loads but WS immediately disconnects | Check WebSockets is enabled (Part 2.3) |
| QR codes show `localhost` URLs | `PUBLIC_URL` env var not set or not saved |
| Redis errors in logs | Check `REDIS_URL` format: must start `rediss://` (double-s) |
| App returns 503 on F1 tier after idle | F1 sleeps — upgrade to B1 for live events |
| `Cannot find module 'ioredis'` | Run `npm install` before zipping (Part 4 Option A) |

---

## Part 6 — Horizontal scaling (optional, B1+ tier only)

If you scale out to multiple instances:

1. App Service → **Scale out (App Service plan)** → set instance count
   to 2 or more.
2. Because `REDIS_URL` is set, every instance subscribes to the same
   Redis channel and will deliver commands to its locally-connected
   phones. The dashboard/control panel only needs to connect to one
   instance — Redis fans the broadcast out to all.

The F1 free tier is single-instance only. You need at least B1 + manual
scale-out (or B2+ with autoscale) for multi-instance.

---

## Local development (quick reference)

```bash
cp .env.example .env
# Edit .env: set PUBLIC_URL=http://localhost:3000, leave REDIS_URL blank

npm install
npm start
# Open http://localhost:3000
```
