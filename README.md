# DASHPIPE — Educational DASH Streaming Demo

A fully working local streaming server that demonstrates the complete pipeline:

```
Login → Session Token → Proxy → CDN Token (60s) → MPD Manifest → DRM License → Segments → Playback
```

---

## What This Teaches You

| Stage | Endpoint              | What it does                                      |
|-------|-----------------------|---------------------------------------------------|
| 1     | POST `/login`         | Issues a 1-hour session token                     |
| 2     | GET `/proxy/:channel` | Validates token → picks CDN → issues 60s CDN token → 302 redirect |
| 3     | GET `/cdn/:tok/manifest.mpd` | Validates CDN token → returns DASH MPD with DRM info |
| 4     | POST `/license`       | ClearKey DRM license server → returns AES-128 key |
| 5     | GET `/cdn/:tok/seg/*` | Validates token → proxies encrypted segments      |

---

## Setup (takes about 2 minutes)

### Step 1 — Install Node.js
Download from https://nodejs.org (choose LTS version)

### Step 2 — Install dependencies
Open a terminal in this folder and run:
```
npm install
```

### Step 3 — Start the server
```
npm start
```

You'll see:
```
╔══════════════════════════════════════════════╗
║      DASHPIPE — Streaming Server             ║
╠══════════════════════════════════════════════╣
║  Player  →  http://localhost:3000            ║
║  Accounts:  demo / demo123                   ║
╚══════════════════════════════════════════════╝
```

### Step 4 — Open the player
Go to http://localhost:3000 in Chrome or Firefox

---

## Accounts
| Username | Password |
|----------|----------|
| demo     | demo123  |
| test     | test456  |
| admin    | admin789 |

---

## Key Things to Observe

### Why the token changes every Load click:
Every click generates a new CDN token because the timestamp changes:
```
hash(sessionToken + cdnServer + timestamp + secret) → new unique token
```

### Why the CDN server changes:
Load balancing picks randomly from: cs5, cs6, cs7, cs8

### The 60-second CDN token:
Watch the green bar at the bottom of the player — it counts down from 60s.
After it expires, the CDN returns 403. Press Load again to get a fresh token.

### ClearKey DRM flow:
1. MPD contains `<ContentProtection schemeIdUri="urn:uuid:e2719d58...">`
2. Shaka Player sees this and calls POST /license
3. Our server responds with the AES-128 key in W3C ClearKey format
4. Shaka decrypts segments in the browser

---

## API Reference (try in browser or curl)

```bash
# Login
curl -X POST http://localhost:3000/login \
  -H "Content-Type: application/json" \
  -d '{"username":"demo","password":"demo123"}'

# Proxy request (replace TOKEN with value from login)
curl -L http://localhost:3000/proxy/Ch120?e=.mpd&token=TOKEN

# License (ClearKey)
curl -X POST http://localhost:3000/license

# Health check
curl http://localhost:3000/api/health

# Request log
curl http://localhost:3000/api/log
```

---

## File Structure
```
dashpipe/
├── server.js          ← Main server (proxy + CDN + DRM + segment proxy)
├── package.json       ← Dependencies
├── public/
│   └── index.html     ← Player UI (Shaka Player + pipeline visualizer)
└── README.md
```

---

## Content Source
This demo proxies Shaka Player's publicly available `angel-one-clearkey` test stream,
which is hosted by Google on Google Cloud Storage and is freely available for educational use.

The ClearKey DRM keys are the official public test keys published by Google in the
Shaka Player repository (see shaka-player.appspot.com/demo).

---

## Understanding the Code

### server.js key sections:
- `createSessionToken()` — generates MD5 hash of user+ip+timestamp
- `createCdnToken()` — generates SHA256 base64url token with 60s TTL
- `buildMpd()` — constructs the DASH manifest XML pointing to our license server
- `/license` endpoint — returns W3C ClearKey JSON response

### Why two different token types:
- **Session token** — long lived (1h), tied to your login, validates who you are
- **CDN token** — short lived (60s), generated per-request, validates this specific stream load
