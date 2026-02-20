/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║         DASHPIPE — Educational Streaming Server          ║
 * ║                                                          ║
 * ║  Simulates the full pipeline:                           ║
 * ║  Login → Session Token → Proxy → CDN Token →           ║
 * ║  Manifest (MPD) → DRM License → Segments → Play        ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 *  Stage 1 │ /proxy/:channel     → validates session token
 *           │                       picks CDN server
 *           │                       generates short-lived CDN token
 *           │                       302 redirect → CDN URL
 *
 *  Stage 2 │ /cdn/:token/manifest.mpd
 *           │                       validates CDN token (60s expiry!)
 *           │                       returns DASH MPD with DRM info
 *
 *  Stage 3 │ /license             → ClearKey DRM license server
 *           │                       validates license request
 *           │                       returns AES-128 key
 *
 *  Stage 4 │ /cdn/:token/seg/*    → validates CDN token
 *           │                       proxies encrypted segments
 *           │                       from upstream Google CDN
 */

'use strict';

const express = require('express');
const crypto  = require('crypto');
const https   = require('https');
const http    = require('http');
const path    = require('path');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════

const PORT       = process.env.PORT || 3000;   // Render sets PORT automatically
const SECRET     = process.env.SECRET     || 'proxy_secret_key_!@#$';
const CDN_SECRET = process.env.CDN_SECRET || 'cdn_secret_key_$%^&';
const SESSION_TTL = 60 * 60 * 1000;           // 1 hour in ms
const CDN_TTL     = 60 * 1000;                // 60 seconds in ms  ← short lived!

// Simulated CDN server pool (like Dialog's bpcdncs5..cs8)
const CDN_POOL = ['cs5', 'cs6', 'cs7', 'cs8'];

// Demo user accounts  (username → password)
const USERS = {
  'demo':  'demo123',
  'test':  'test456',
  'admin': 'admin789'
};

// ══════════════════════════════════════════════════════════
// ClearKey DRM KEYS
// These are the real public test keys for Shaka's
// angel-one-clearkey demo stream, published openly
// by Google in their Shaka Player test suite.
//
// Key ID  (hex): 9ab40503e44b480293256257542f2299
// Key     (hex): 166630c67582ac7d76e5b8fc8c42f083
// ══════════════════════════════════════════════════════════
const CLEARKEYS = {
  '9ab40503e44b480293256257542f2299': '166630c67582ac7d76e5b8fc8c42f083'
};

// Upstream content source (Shaka's public demo — freely available)
const UPSTREAM = 'storage.googleapis.com';
const UPSTREAM_BASE = '/shaka-demo-assets/angel-one-clearkey';

// ══════════════════════════════════════════════════════════
// IN-MEMORY STORES  (use Redis/DB in production)
// ══════════════════════════════════════════════════════════

const sessionStore  = new Map();   // token → session data
const cdnTokenStore = new Map();   // cdnToken → CDN token data
const requestLog    = [];          // last 100 requests for /api/log

function logReq(type, detail) {
  const entry = { ts: Date.now(), type, detail };
  requestLog.unshift(entry);
  if (requestLog.length > 100) requestLog.pop();
  console.log(`[${type}] ${detail}`);
}

// ══════════════════════════════════════════════════════════
// TOKEN HELPERS
// ══════════════════════════════════════════════════════════

/** Generate a session token tied to user + IP + timestamp */
function createSessionToken(userId, ip) {
  const ts  = Date.now();
  const raw = `${userId}:${ip}:${ts}:${SECRET}`;
  const tok = crypto.createHash('md5').update(raw).digest('hex');
  sessionStore.set(tok, {
    userId,
    ip,
    createdAt: ts,
    expiresAt: ts + SESSION_TTL
  });
  return tok;
}

/** Validate a session token. Returns { ok, reason, session } */
function checkSessionToken(token, ip) {
  const s = sessionStore.get(token);
  if (!s)                       return { ok: false, reason: 'token not found' };
  if (Date.now() > s.expiresAt) {
    sessionStore.delete(token);
    return { ok: false, reason: 'token expired' };
  }
  // In a real system: if (s.ip !== ip) return { ok:false, reason:'IP mismatch' }
  return { ok: true, session: s };
}

/** Generate a short-lived CDN token (60 seconds only!) */
function createCdnToken(sessionToken, cdnServer, channel) {
  const ts  = Date.now();
  const raw = `${sessionToken}:${cdnServer}:${channel}:${ts}:${CDN_SECRET}`;
  // BroadPeak-style: prefix + base64url body
  const body   = crypto.createHash('sha256').update(raw).digest('base64url').slice(0, 36);
  const prefix = Math.random() > 0.5 ? '1ab' : '1aa';
  const tok    = `${prefix}@${body}`;

  cdnTokenStore.set(tok, {
    sessionToken,
    cdnServer,
    channel,
    createdAt: ts,
    expiresAt: ts + CDN_TTL   // only 60 seconds!
  });
  return tok;
}

/** Validate a CDN token */
function checkCdnToken(token) {
  const t = cdnTokenStore.get(token);
  if (!t)                       return { ok: false, reason: 'CDN token not found — may have expired' };
  if (Date.now() > t.expiresAt) {
    cdnTokenStore.delete(token);
    return { ok: false, reason: 'CDN token expired (60s limit reached)' };
  }
  const secsLeft = Math.round((t.expiresAt - Date.now()) / 1000);
  return { ok: true, data: t, secsLeft };
}

// ══════════════════════════════════════════════════════════
// MPD BUILDER
// ══════════════════════════════════════════════════════════
/**
 * Builds a DASH MPD that:
 *  - Uses ContentProtection (ClearKey DRM)
 *  - Points license server to our /license endpoint
 *  - Points segments to our /cdn/:token/seg/ proxy
 */
function buildMpd(host, cdnToken) {
  const segBase = `http://${host}/cdn/${encodeURIComponent(cdnToken)}/seg/`;
  const licUrl  = `http://${host}/license`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  ╔══════════════════════════════════════════════╗
  ║  DASHPIPE — Generated Manifest               ║
  ║  CDN Token : ${cdnToken.slice(0, 20)}...     ║
  ║  License   : ${licUrl}                       ║
  ║  DRM Type  : ClearKey (AES-128-CTR / CENC)  ║
  ╚══════════════════════════════════════════════╝
-->
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     xmlns:cenc="urn:mpeg:cenc:2013"
     xmlns:mspr="urn:microsoft:playready"
     profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"
     type="static"
     mediaPresentationDuration="PT1M14.167S"
     minBufferTime="PT1.5S">

  <Period id="0" start="PT0S">

    <!-- ── VIDEO TRACKS ────────────────────────────────── -->
    <AdaptationSet id="1" contentType="video" mimeType="video/mp4"
                   codecs="avc1.42c00d" frameRate="25" par="16:9">

      <!-- DRM: ClearKey — license server is OUR local endpoint -->
      <ContentProtection
        schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e"
        value="ClearKey1.0">
        <cenc:default_KID>9ab40503-e44b-4802-9325-6257542f2299</cenc:default_KID>
        <dashif:laurl xmlns:dashif="https://dashif.org/CPS"
          licenseType="temporary">${licUrl}</dashif:laurl>
      </ContentProtection>
      <ContentProtection
        schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"
        cenc:default_KID="9ab40503-e44b-4802-9325-6257542f2299"/>

      <!-- 144p — 100 kbps -->
      <Representation id="v1" bandwidth="100000" width="256" height="144" sar="1:1">
        <BaseURL>${segBase}</BaseURL>
        <SegmentTemplate
          initialization="v-0144p-0100k-libx264-init.mp4"
          media="v-0144p-0100k-libx264-$Number$.m4s"
          timescale="90000" duration="250000" startNumber="1"/>
      </Representation>

      <!-- 240p — 250 kbps -->
      <Representation id="v2" bandwidth="250000" width="424" height="240" sar="1:1">
        <BaseURL>${segBase}</BaseURL>
        <SegmentTemplate
          initialization="v-0240p-0250k-libx264-init.mp4"
          media="v-0240p-0250k-libx264-$Number$.m4s"
          timescale="90000" duration="250000" startNumber="1"/>
      </Representation>

      <!-- 360p — 550 kbps -->
      <Representation id="v3" bandwidth="550000" width="640" height="360" sar="1:1">
        <BaseURL>${segBase}</BaseURL>
        <SegmentTemplate
          initialization="v-0360p-0550k-libx264-init.mp4"
          media="v-0360p-0550k-libx264-$Number$.m4s"
          timescale="90000" duration="250000" startNumber="1"/>
      </Representation>

      <!-- 480p — 1 Mbps -->
      <Representation id="v4" bandwidth="1000000" width="854" height="480" sar="1:1">
        <BaseURL>${segBase}</BaseURL>
        <SegmentTemplate
          initialization="v-0480p-1000k-libx264-init.mp4"
          media="v-0480p-1000k-libx264-$Number$.m4s"
          timescale="90000" duration="250000" startNumber="1"/>
      </Representation>

      <!-- 720p — 1.8 Mbps -->
      <Representation id="v5" bandwidth="1800000" width="1280" height="720" sar="1:1">
        <BaseURL>${segBase}</BaseURL>
        <SegmentTemplate
          initialization="v-0720p-1800k-libx264-init.mp4"
          media="v-0720p-1800k-libx264-$Number$.m4s"
          timescale="90000" duration="250000" startNumber="1"/>
      </Representation>

    </AdaptationSet>

    <!-- ── AUDIO TRACKS ────────────────────────────────── -->
    <AdaptationSet id="2" contentType="audio" mimeType="audio/mp4"
                   codecs="mp4a.40.2" lang="en">

      <ContentProtection
        schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e"
        value="ClearKey1.0">
        <cenc:default_KID>9ab40503-e44b-4802-9325-6257542f2299</cenc:default_KID>
        <dashif:laurl xmlns:dashif="https://dashif.org/CPS"
          licenseType="temporary">${licUrl}</dashif:laurl>
      </ContentProtection>

      <!-- English Stereo 128kbps -->
      <Representation id="a1" bandwidth="128000">
        <BaseURL>${segBase}</BaseURL>
        <SegmentTemplate
          initialization="a-0128k-aac-init.mp4"
          media="a-0128k-aac-$Number$.m4s"
          timescale="44100" duration="177408" startNumber="1"/>
      </Representation>

      <!-- English Stereo 64kbps -->
      <Representation id="a2" bandwidth="64000">
        <BaseURL>${segBase}</BaseURL>
        <SegmentTemplate
          initialization="a-0064k-aac-init.mp4"
          media="a-0064k-aac-$Number$.m4s"
          timescale="44100" duration="177408" startNumber="1"/>
      </Representation>

    </AdaptationSet>

    <!-- ── SUBTITLES ───────────────────────────────────── -->
    <AdaptationSet id="3" contentType="text" mimeType="text/vtt" lang="en">
      <Representation id="s1" bandwidth="1000">
        <BaseURL>${segBase}subtitles/</BaseURL>
        <SegmentTemplate media="angel_one_en-$Number$.vtt"
          timescale="1" duration="10" startNumber="1"/>
      </Representation>
    </AdaptationSet>

  </Period>
</MPD>`;
}

// ══════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════

// ── Health check ──────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    sessions: sessionStore.size,
    cdnTokens: cdnTokenStore.size,
    uptime: process.uptime().toFixed(0) + 's'
  });
});

// ── Request log (for the UI) ───────────────────────────────
app.get('/api/log', (req, res) => res.json(requestLog));

// ── Token info ─────────────────────────────────────────────
app.get('/api/session/:token', (req, res) => {
  const s = sessionStore.get(req.params.token);
  if (!s) return res.json({ valid: false });
  const remaining = Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000));
  res.json({
    valid: true,
    userId: s.userId,
    remaining,
    expiresAt: new Date(s.expiresAt).toISOString(),
    token: req.params.token
  });
});

// ── LOGIN ─────────────────────────────────────────────────
//   POST /login  { username, password }
//   ← { success, token, expiresIn }
app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  logReq('LOGIN', `user=${username} ip=${req.ip}`);

  if (!username || !password)
    return res.status(400).json({ success: false, message: 'username and password required' });

  if (USERS[username] !== password)
    return res.status(401).json({ success: false, message: 'Invalid credentials' });

  const token = createSessionToken(username, req.ip);
  logReq('TOKEN_ISSUED', `user=${username} token=${token.slice(0,8)}... expires=1h`);

  res.json({
    success: true,
    token,
    userId: username,
    expiresIn: SESSION_TTL / 1000,
    message: `Welcome ${username}! Session valid for 1 hour.`
  });
});

// ── LOGOUT ────────────────────────────────────────────────
app.post('/logout', (req, res) => {
  const { token } = req.body || {};
  if (token) sessionStore.delete(token);
  res.json({ success: true });
});

// ── STAGE 1: PROXY ────────────────────────────────────────
//   GET /proxy/:channel?e=.mpd&token=SESSION_TOKEN
//   Validates session → picks CDN server → creates CDN token → 302
app.get('/proxy/:channel', (req, res) => {
  const channel  = req.params.channel;
  const token    = req.query.token;
  const ext      = req.query.e || '.mpd';

  logReq('PROXY_REQ', `channel=${channel} token=${(token||'').slice(0,8)}...`);

  if (!token)
    return res.status(401).json({ error: 'No session token provided', hint: 'POST /login first' });

  const check = checkSessionToken(token, req.ip);
  if (!check.ok) {
    logReq('PROXY_DENY', `reason=${check.reason}`);
    return res.status(403).json({
      error: `Access denied: ${check.reason}`,
      hint: 'Your session has expired. POST /login again to get a new token.'
    });
  }

  // Load balance — pick a CDN server
  const cdnServer = CDN_POOL[Math.floor(Math.random() * CDN_POOL.length)];

  // Generate short-lived CDN token
  const cdnToken = createCdnToken(token, cdnServer, channel);
  const remaining = Math.round((check.session.expiresAt - Date.now()) / 1000);

  logReq('PROXY_OK', `channel=${channel} → CDN=${cdnServer} cdnToken=${cdnToken.slice(0,12)}... sessionLeft=${remaining}s`);

  // 302 redirect to our CDN endpoint (exactly like BroadPeak redirect)
  const redirectUrl = `http://${req.headers.host}/cdn/${encodeURIComponent(cdnToken)}/manifest.mpd`;

  res.set('X-Session-Remaining', remaining + 's');
  res.set('X-CDN-Server', `bpcdn${cdnServer}.example.lk`);
  res.set('X-CDN-Token', cdnToken.slice(0, 12) + '...');
  res.redirect(302, redirectUrl);
});

// ── STAGE 2: CDN MANIFEST ─────────────────────────────────
//   GET /cdn/:cdnToken/manifest.mpd
//   Validates CDN token (60s!) → returns MPD XML
app.get('/cdn/:cdnToken/manifest.mpd', (req, res) => {
  const cdnToken = decodeURIComponent(req.params.cdnToken);
  logReq('CDN_MANIFEST', `token=${cdnToken.slice(0,12)}...`);

  const check = checkCdnToken(cdnToken);
  if (!check.ok) {
    logReq('CDN_DENY', `reason=${check.reason}`);
    return res.status(403).send(`
      CDN Error: ${check.reason}
      The CDN token is only valid for 60 seconds.
      Go back to the player and reload — a fresh token will be generated.
    `.trim());
  }

  logReq('CDN_OK', `server=bpcdn${check.data.cdnServer} channel=${check.data.channel} secsLeft=${check.secsLeft}s`);

  const mpd = buildMpd(req.headers.host, cdnToken);

  res.set('Content-Type', 'application/dash+xml');
  res.set('X-CDN-Server', `bpcdn${check.data.cdnServer}.example.lk`);
  res.set('X-CDN-Expires', check.secsLeft + 's');
  res.set('Access-Control-Allow-Origin', '*');
  res.send(mpd);
});

// ── STAGE 2b: CDN SEGMENT PROXY ───────────────────────────
//   GET /cdn/:cdnToken/seg/:segPath
//   Validates CDN token → proxies segment from upstream
app.get('/cdn/:cdnToken/seg/*', (req, res) => {
  const cdnToken = decodeURIComponent(req.params.cdnToken);
  const segPath  = req.params[0];

  const check = checkCdnToken(cdnToken);
  if (!check.ok) {
    return res.status(403).send('CDN token expired — reload player');
  }

  // Skip subtitles (not in the upstream)
  if (segPath.includes('subtitles') || segPath.endsWith('.vtt')) {
    return res.status(404).send('');
  }

  const upstreamPath = `${UPSTREAM_BASE}/${segPath}`;
  logReq('CDN_SEG', `server=${check.data.cdnServer} seg=${segPath}`);

  // Proxy the segment from Google's CDN
  const options = {
    hostname: UPSTREAM,
    path: upstreamPath,
    method: 'GET',
    headers: { 'User-Agent': 'DashPipe/1.0' }
  };

  const proxyReq = https.request(options, (upstream) => {
    if (upstream.statusCode === 404) {
      return res.status(404).send('Segment not found');
    }
    res.set('Content-Type', upstream.headers['content-type'] || 'video/mp4');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('X-CDN-Server', `bpcdn${check.data.cdnServer}.example.lk`);
    upstream.pipe(res);
  });

  proxyReq.on('error', (err) => {
    logReq('SEG_ERR', err.message);
    if (!res.headersSent) res.status(502).send('Upstream error');
  });

  proxyReq.end();
});

// ── STAGE 3: DRM LICENSE SERVER ───────────────────────────
//   POST /license
//   Receives ClearKey license request → returns keys
app.post('/license', (req, res) => {
  logReq('DRM_LICENSE', `ip=${req.ip} contentType=${req.headers['content-type']}`);

  // Build W3C ClearKey license response
  // Format: { keys: [{ kty, kid, k }], type }
  const keys = Object.entries(CLEARKEYS).map(([kidHex, keyHex]) => ({
    kty: 'oct',
    kid: Buffer.from(kidHex, 'hex').toString('base64url'),
    k:   Buffer.from(keyHex, 'hex').toString('base64url')
  }));

  const response = { keys, type: 'temporary' };

  logReq('DRM_KEY_ISSUED', `keys=${keys.length} keyId=${keys[0]?.kid?.slice(0,8)}...`);

  res.set('Content-Type', 'application/json');
  res.set('Access-Control-Allow-Origin', '*');
  res.json(response);
});

// Handle preflight for license
app.options('/license', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// ── CATCH ALL → serve index.html ──────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ══════════════════════════════════════════════════════════
// CLEANUP: Remove expired tokens every 30 seconds
// ══════════════════════════════════════════════════════════
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [k, v] of sessionStore)  { if (now > v.expiresAt) { sessionStore.delete(k);  cleaned++; } }
  for (const [k, v] of cdnTokenStore) { if (now > v.expiresAt) { cdnTokenStore.delete(k); cleaned++; } }
  if (cleaned > 0) console.log(`[CLEANUP] Removed ${cleaned} expired token(s)`);
}, 30000);

// ══════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║      DASHPIPE — Streaming Server             ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Player  →  http://localhost:${PORT}             ║`);
  console.log('║                                              ║');
  console.log('║  Accounts:  demo / demo123                   ║');
  console.log('║             test / test456                   ║');
  console.log('║             admin / admin789                 ║');
  console.log('║                                              ║');
  console.log('║  Stage 1  →  /proxy/:channel?token=X        ║');
  console.log('║  Stage 2  →  /cdn/:token/manifest.mpd       ║');
  console.log('║  Stage 3  →  POST /license (ClearKey DRM)   ║');
  console.log('║  Stage 4  →  /cdn/:token/seg/:file          ║');
  console.log('╚══════════════════════════════════════════════╝\n');
});
