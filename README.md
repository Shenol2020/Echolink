# Crowd Lights — Mobile LED Wristband System

A web app that turns the crowd's phone screens into a synchronized,
section-based light display — same idea as physical LED wristbands,
controlled from one dashboard.

## What's included

```
server.js              Node + ws WebSocket server (no build step)
public/dashboard.html  Step 1: set section count, generate QR codes
public/control.html    Step 2: operator color + pattern control
public/phone.html      Step 3: crowd view (opened by scanning a QR code)
```

## Setup

Requires Node.js 18+ and an internet connection for the one-time install
(this was built in a sandboxed environment with no network access, so the
`ws` install and a live end-to-end run couldn't be done here — but the
code has been syntax-checked and the client/server message contract has
been traced by hand; see "What was and wasn't tested" below).

```bash
npm install ws
node server.js
```

You'll see:

```
Wristband server running at http://localhost:3000
  Dashboard:     http://localhost:3000/
  Control panel: http://localhost:3000/control
  Phone view:    http://localhost:3000/phone?section=1
```

## How to run a session

1. **Open the dashboard** (`/`) on the operator's laptop. Enter how many
   sections you need (or use the 1 / 2 / 4 presets) and click **Generate
   QR codes**. This initializes the session on the server.
2. **Display each QR code** to its matching part of the crowd (e.g.
   project "Front" on a screen near the front section, etc).
3. **Crowd scans their section's QR code** with their phone camera. It
   opens `phone.html`, which immediately starts the clock-sync handshake
   and joins that section's WebSocket room.
4. **Open the control panel** (`/control`) — either in a new tab on the
   same laptop, or on a second device on the same network. From here you
   can:
   - Pick a target (one section or all) and apply a manual color
   - Click any of the 12 synchronized patterns to fire it across the
     selected target
   - Adjust the **sync lead time** slider (how far in the future the
     server schedules the trigger — gives slower phones time to receive
     and prepare before the deadline)
   - Hit **Stop pattern / blackout all** at any time

## Network notes

- The phone and the operator's machine must be able to reach the
  server's address. For a quick local test, run the server on a laptop
  connected to the same Wi-Fi as the phones, and have phones browse to
  `http://<laptop-LAN-IP>:3000/phone?section=1` (find the LAN IP with
  `ipconfig`/`ifconfig`). The dashboard's QR codes encode whatever host
  the dashboard itself was loaded from, so load the dashboard using the
  LAN IP too, not `localhost`, or the QR codes will point phones at an
  address only the laptop can reach.
- This is the "small/local test" build: one Node process, in-memory
  state, no Redis. It comfortably handles dozens of concurrent phones on
  one process. If you later need stadium scale, the multi-instance +
  Redis pub/sub pattern from your original notes is the next step, along
  with moving section state out of process memory.

## How the sync works

Each phone runs a Web Worker that performs a 4-point handshake (T1–T4)
with the server every 30 seconds, keeping a rolling average of the last
5 offset measurements to smooth out network jitter. When the operator
fires a pattern, the server doesn't say "now" — it picks a timestamp
~500ms in the future (adjustable) and sends that to every phone in the
target section(s). Each phone waits, using its own synced clock, until
that exact millisecond to start the pattern, so phones across the venue
flip in unison even though the message arrived at slightly different
times. The Web Worker keeps this timing loop alive even if a phone's
screen briefly dims or the tab backgrounds, which is where plain
`setTimeout` on the main thread tends to drift or stall on mobile.

## Pattern library

| Pattern | What it does |
|---|---|
| Solid wash | All targeted sections snap to one color instantly |
| Strobe | Rapid flash between color and black |
| Pulse / breathe | Smooth sine fade in and out |
| Heartbeat | Double-pulse "lub-dub" flash, repeating |
| Chase wave | Sections light up in sequence around the venue |
| Color bounce | A point of color ping-pongs across sections |
| Alternate (odd/even) | Odd vs even sections flip between two colors |
| Rainbow cycle | Hue rotates continuously through the spectrum |
| Random sparkle | Each phone flickers independently within a palette |
| Countdown flash | Flashes N times, accelerating, then holds solid — built for a drop |
| Directional wave | Like Chase, but explicitly reversed order |
| Build-up fade | Slow fade from black to full color over several seconds |

All patterns are defined as small JSON `command` objects in
`control.html` and interpreted by a `mode`-keyed switch in `phone.html`,
so adding a new pattern just means adding one card + one case block.

## What was and wasn't tested

This was built in a network-isolated sandbox, so I could not run
`npm install` or do a live multi-client WebSocket test here. What I did
verify directly:

- `server.js` passes `node --check` (valid syntax)
- All three inline client scripts pass `node --check` after extraction
- Every WebSocket message type sent by a client has a matching handler
  on the server, and every message type the server sends has a matching
  handler on the receiving client(s) — traced by hand across all four
  files (see table in the build notes)
- The 12 pattern `mode` values produced by `control.html` all have a
  corresponding `case` in `phone.html`'s pattern engine

What I could not verify here and you should sanity-check on first run:
actual browser behavior (Web Worker creation via Blob URL, CSS color
transitions, QR scan → load flow), real network latency/RTT behavior,
and multi-phone visual sync in person.
