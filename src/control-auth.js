import crypto from 'crypto';
import {
  CONTROL_AUTH_USERNAME,
  CONTROL_AUTH_PASSWORD,
  SLOT_LOGINS,
} from './config.js';
import { findSlotLogin } from './vmix/event-registry.js';

const SESSION_COOKIE = 'eidfaxi_control_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
// token -> { expiresAt, role: 'admin'|'slot', slot: number|null }
const sessions = new Map();

function now() {
  return Date.now();
}

function pruneSessions() {
  const t = now();
  for (const [token, sess] of sessions.entries()) {
    if (!sess || sess.expiresAt <= t) sessions.delete(token);
  }
}

function parseCookies(req) {
  const raw = req.header('cookie') || '';
  const out = {};
  raw.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx <= 0) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(value);
  });
  return out;
}

function getSessionToken(req) {
  const cookies = parseCookies(req);
  return cookies[SESSION_COOKIE] || '';
}

/**
 * Return the active session object for a request, or null.
 * Session shape: { expiresAt, role: 'admin'|'slot', slot: number|null }
 */
function getActiveSession(req) {
  pruneSessions();
  const token = getSessionToken(req);
  if (!token) return null;
  const sess = sessions.get(token);
  if (!sess || sess.expiresAt <= now()) {
    sessions.delete(token);
    return null;
  }
  return sess;
}

function isAuthenticated(req) {
  return getActiveSession(req) !== null;
}

/**
 * Resolve the role/slot for a request, considering both cookie sessions and
 * HTTP Basic auth (admin only, for API/vMix tooling).
 *
 * @returns {{ role: 'admin'|'slot', slot: number|null } | null}
 */
export function getRequestRole(req) {
  const sess = getActiveSession(req);
  if (sess) return { role: sess.role, slot: sess.slot ?? null };
  if (isBasicAuthenticated(req)) return { role: 'admin', slot: null };
  return null;
}

function isBasicAuthenticated(req) {
  const authHeader = String(req.header('authorization') || '');
  if (!authHeader.toLowerCase().startsWith('basic ')) {
    return false;
  }

  const encoded = authHeader.slice(6).trim();
  if (!encoded) return false;

  let decoded = '';
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return false;
  }

  const sep = decoded.indexOf(':');
  if (sep < 0) return false;

  const username = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);
  return (
    Boolean(CONTROL_AUTH_USERNAME) &&
    Boolean(CONTROL_AUTH_PASSWORD) &&
    username === CONTROL_AUTH_USERNAME &&
    password === CONTROL_AUTH_PASSWORD
  );
}

function setSessionCookie(res, token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

function renderLoginHtml(errorMessage = '') {
  const errorBlock = errorMessage
    ? `<div class="error">${errorMessage}</div>`
    : '';
  return `<!doctype html>
<html lang="is">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Eidfaxi Innskraning</title>
  <style>
    :root { --bg:#f3f4f6; --panel:#ffffff; --line:#d1d5db; --fg:#111827; --muted:#6b7280; --primary:#2563eb; --primaryDark:#1d4ed8; --danger:#b91c1c; }
    * { box-sizing:border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; }
    html,body { margin:0; min-height:100%; }
    body { min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg); }
    .card { width:min(420px, calc(100% - 28px)); background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:20px; }
    h1 { margin:0 0 6px; font-size:24px; }
    .muted { color:var(--muted); margin:0 0 14px; }
    label { display:block; margin:10px 0 6px; color:var(--muted); font-size:13px; font-weight:600; }
    input { width:100%; padding:11px 12px; border-radius:8px; border:1px solid #cbd5e1; background:#fff; color:var(--fg); font-size:15px; }
    input:focus { outline:none; border-color:#93c5fd; box-shadow:0 0 0 3px rgba(147,197,253,.35); }
    button { width:100%; margin-top:14px; padding:11px; border:1px solid #1e40af; border-radius:8px; background:var(--primary); color:#fff; font-weight:600; font-size:15px; cursor:pointer; }
    button:hover { background:var(--primaryDark); }
    .error { margin-top:10px; color:var(--danger); font-size:14px; }
  </style>
</head>
<body>
  <form class="card" method="post" action="/control/login">
    <h1>Eidfaxi Stjorn</h1>
    <p class="muted">Skráðu þig inn til að opna stjórnsíðu.</p>
    <label>Notandanafn</label>
    <input name="username" autocomplete="username" required />
    <label>Lykilorð</label>
    <input name="password" type="password" autocomplete="current-password" required />
    <button type="submit">Innskraning</button>
    ${errorBlock}
  </form>
</body>
</html>`;
}

export function requireControlSession(req, res, api = false) {
  if (isAuthenticated(req)) return true;
  if (api && isBasicAuthenticated(req)) return true;
  if (api) {
    res.status(401).json({ error: 'Unauthorized' });
  } else {
    res.redirect('/control/login');
  }
  return false;
}

/**
 * Require an admin session (full access to all slots).
 * For API routes, responds 401/403; for pages, redirects to login.
 */
export function requireAdmin(req, res, api = false) {
  const role = getRequestRole(req);
  if (role && role.role === 'admin') return true;
  if (!role) {
    if (api) {
      res.status(401).json({ error: 'Unauthorized' });
    } else {
      res.redirect('/control/login');
    }
    return false;
  }
  // Authenticated but not admin
  res.status(403).json({ error: 'Forbidden: admin access required' });
  return false;
}

/**
 * Check whether the request is allowed to access a given slot number.
 * Admins can access any slot; slot users only their own.
 *
 * @returns {boolean}
 */
export function canAccessSlot(req, slot) {
  const role = getRequestRole(req);
  if (!role) return false;
  if (role.role === 'admin') return true;
  return Number(role.slot) === Number(slot);
}

export function registerControlAuthRoutes(app) {
  // The login UI now lives in the React app at /app/login. Keep this GET
  // route as a redirect so existing links / the auth-guard redirect still work.
  app.get('/control/login', (req, res) => {
    res.redirect('/app/login');
  });

  app.post('/control/login', (req, res) => {
    const wantsJson =
      String(req.header('accept') || '').includes('application/json') ||
      String(req.header('content-type') || '').includes('application/json');

    const hasAdmin = CONTROL_AUTH_USERNAME && CONTROL_AUTH_PASSWORD;
    const hasSlotLogins = SLOT_LOGINS.size > 0;

    if (!hasAdmin && !hasSlotLogins) {
      const msg =
        'Innskraning er ekki stillt. Settu CONTROL_AUTH_USERNAME og CONTROL_AUTH_PASSWORD (eða SLOT_LOGINS) í env.';
      if (wantsJson) {
        return res.status(500).json({ ok: false, error: msg });
      }
      res.status(500);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderLoginHtml(msg));
      return;
    }

    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');

    let role = null;
    let slot = null;

    if (
      hasAdmin &&
      username === CONTROL_AUTH_USERNAME &&
      password === CONTROL_AUTH_PASSWORD
    ) {
      role = 'admin';
    } else if (hasSlotLogins && SLOT_LOGINS.has(username)) {
      const entry = SLOT_LOGINS.get(username);
      if (entry.password === password) {
        role = 'slot';
        slot = entry.slot;
      }
    }

    // Fall back to dynamically-generated slot logins from the registry
    if (!role) {
      const dynamic = findSlotLogin(username);
      if (dynamic && dynamic.password && dynamic.password === password) {
        role = 'slot';
        slot = dynamic.slot;
      }
    }

    if (!role) {
      const msg = 'Rangt notandanafn eða lykilorð.';
      if (wantsJson) {
        return res.status(401).json({ ok: false, error: msg });
      }
      res.status(401);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderLoginHtml(msg));
      return;
    }

    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { expiresAt: now() + SESSION_TTL_MS, role, slot });
    setSessionCookie(res, token);

    const redirectTo = role === 'slot' ? `/app/slot/${slot}` : '/app';

    if (wantsJson) {
      return res.json({ ok: true, role, slot, redirectTo });
    }

    // Slot users go straight to their slot page; admins to the overview.
    res.redirect(redirectTo);
  });

  const handleLogout = (req, res) => {
    const token = getSessionToken(req);
    if (token) sessions.delete(token);
    clearSessionCookie(res);
    const wantsJson =
      String(req.header('accept') || '').includes('application/json') ||
      String(req.header('content-type') || '').includes('application/json');
    if (wantsJson) {
      return res.json({ ok: true });
    }
    res.redirect('/app/login');
  };

  app.post('/control/logout', handleLogout);
  app.get('/control/logout', handleLogout);

  // Lightweight endpoint for the SPA to discover its role and allowed slot.
  app.get('/control/me', (req, res) => {
    const role = getRequestRole(req);
    res.setHeader('Cache-Control', 'no-store');
    if (!role) {
      return res.status(401).json({ authenticated: false });
    }
    res.json({ authenticated: true, role: role.role, slot: role.slot });
  });
}
