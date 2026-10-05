const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  req.now = requestNow(req);
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// The poll: every film anyone has suggested, ranked by votes (a tie goes
// to the film suggested first). Guests may read this, so `req.user` may be
// absent — read routes must not assume it (use `req.user ? req.user.id : null`).
app.get('/api/films', async (req, res) => {
  try {
    const viewerId = req.user ? req.user.id : null;
    const { rows } = await pool.query(`
      SELECT f.id, f.title, f.note, f.added_by_name, f.created_at,
             COUNT(v.id)::int AS votes,
             (SELECT vv.film_id FROM votes vv WHERE vv.voter_id = $1) AS voted_film_id
      FROM films f
      LEFT JOIN votes v ON v.film_id = f.id
      GROUP BY f.id
      ORDER BY COUNT(v.id) DESC, f.created_at ASC
    `, [viewerId]);
    res.json({ films: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Suggest a film. Needs an account; the middleware already answers guests
// with 401 `account_required`. The unique index on lower(title) makes a
// duplicate impossible at the database level; it surfaces here as 409.
app.post('/api/films', async (req, res) => {
  try {
    const body = req.body || {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
    if (!title) return res.status(400).json({ error: 'title_required' });
    if (title.length > 200) return res.status(400).json({ error: 'title_too_long' });
    if (note && note.length > 300) return res.status(400).json({ error: 'note_too_long' });
    const { rows } = await pool.query(`
      INSERT INTO films (title, note, added_by, added_by_name)
      VALUES ($1, $2, $3, $4)
      RETURNING id, title, note, added_by, added_by_name, created_at
    `, [title, note, req.user.id, req.user.username]);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'duplicate' });
    res.status(500).json({ error: err.message });
  }
});

// Vote for a film. One vote per person: `votes` holds exactly one row per
// voter (UNIQUE (voter_id)), and voting for another film moves that row
// rather than adding one. A vote can be switched, never taken back — no
// delete route.
app.post('/api/votes', async (req, res) => {
  try {
    const filmId = Number((req.body || {}).film_id);
    if (!Number.isInteger(filmId)) return res.status(400).json({ error: 'film_id_required' });
    const film = await pool.query('SELECT id FROM films WHERE id = $1', [filmId]);
    if (film.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    await pool.query(`
      INSERT INTO votes (film_id, voter_id, voter_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (voter_id) DO UPDATE
        SET film_id = EXCLUDED.film_id, created_at = NOW()
    `, [filmId, req.user.id, req.user.username]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/friday-film-crew-b43fab/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/friday-film-crew-b43fab/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  // Both tables are append-only: films are never deleted, and a vote is
  // switched by updating the voter's one row, never removed.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS films (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      note VARCHAR(300),
      added_by INTEGER NOT NULL,
      added_by_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // The unique index on lower(title) is what makes "already suggested"
  // impossible at the database level, and seed inserts idempotent.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS films_title_lower_key ON films (lower(title))
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS votes (
      id SERIAL PRIMARY KEY,
      film_id INTEGER NOT NULL REFERENCES films(id),
      voter_id INTEGER NOT NULL,
      voter_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (voter_id)
    )
  `);
  // Staging mock data: a populated poll for the preview. Gated on staging,
  // only when no films exist yet, and obviously fake — placeholder titles,
  // fake usernames, and negative voter ids that can never match a real
  // `req.user.id`, so no real person appears to have voted.
  if (IS_STAGING) {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM films');
    if (rows[0].n === 0) {
      const seeded = await pool.query(`
        INSERT INTO films (title, note, added_by, added_by_name) VALUES
          ($1, $2, -1, $3),
          ($4, $5, -2, $6),
          ($7, $8, -3, $9)
        RETURNING id
      `, [
        'Staging demo: Ghostlight', 'A small mystery everyone can talk over', 'staging-demo-maya',
        'Staging demo: The Long Weekend', 'A comedy, and a good snacks film', 'staging-demo-rafe',
        'Staging demo: Midnight Carousel', 'An entirely made-up musical with a big ending', 'staging-demo-juno',
      ]);
      const [a, b, c] = seeded.rows.map(r => r.id);
      const fakeVotes = [
        [a, -101, 'staging-demo-ada'],
        [a, -102, 'staging-demo-ben'],
        [a, -103, 'staging-demo-cleo'],
        [b, -104, 'staging-demo-dev'],
        [b, -105, 'staging-demo-eva'],
        [c, -106, 'staging-demo-finn'],
      ];
      for (const [filmId, voterId, voterName] of fakeVotes) {
        await pool.query(
          'INSERT INTO votes (film_id, voter_id, voter_name) VALUES ($1, $2, $3)',
          [filmId, voterId, voterName]
        );
      }
    }
  }
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });
