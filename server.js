// RazorGen server.js
// - Serves the app
// - Stores the Anthropic API key server-side (never sent to browser)
// - Username/password login with session tokens
// - Optional IP allowlist

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ─── Load .env ────────────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    console.error('\n  ERROR: .env file not found.');
    console.error('  Copy .env.example to .env and fill in your values.\n');
    process.exit(1);
  }
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    const k = t.slice(0, idx).trim();
    const v = t.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    process.env[k] = v;
  }
}
loadEnv();

const PORT    = parseInt(process.env.PORT || '43000');
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL   = process.env.ANTHROPIC_MODEL   || 'claude-sonnet-4-20250514';
const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 hours

// ─── Users ────────────────────────────────────────────────────────────────────
// .env format:  USERS=alice:pass1,bob:pass2
function loadUsers() {
  const users = {};
  for (const pair of (process.env.USERS || '').split(',')) {
    const [u, ...rest] = pair.trim().split(':');
    const p = rest.join(':').trim();
    if (u && p) users[u.trim()] = p;
  }
  return users;
}
const USERS = loadUsers();
if (Object.keys(USERS).length === 0) {
  console.error('\n  ERROR: No users defined. Add USERS=name:password to .env\n');
  process.exit(1);
}

// ─── IP allowlist ─────────────────────────────────────────────────────────────
// .env format:  ALLOWED_IPS=192.168.1.10,192.168.1.20  (leave blank = allow all)
const ALLOWED_IPS = (process.env.ALLOWED_IPS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function getIp(req) {
  return ((req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0].trim());
}
function ipAllowed(ip) {
  if (ALLOWED_IPS.length === 0) return true;
  if (['127.0.0.1','::1','::ffff:127.0.0.1'].includes(ip)) return true;
  return ALLOWED_IPS.some(a => ip === a || ip === `::ffff:${a}`);
}

// ─── Sessions ─────────────────────────────────────────────────────────────────
const sessions = new Map();
function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, expires: Date.now() + SESSION_TTL });
  return token;
}
function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(token); return null; }
  s.expires = Date.now() + SESSION_TTL;
  return s;
}
function parseCookies(req) {
  const c = {};
  for (const p of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = p.trim().split('=');
    if (k) c[k.trim()] = v.join('=');
  }
  return c;
}
function authed(req) {
  return !!getSession(parseCookies(req)['rtg_session']);
}

// ─── Body reader ──────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((res, rej) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => res(b));
    req.on('error', rej);
  });
}

// ─── Login page ───────────────────────────────────────────────────────────────
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RazorGen — Sign in</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  background:#111827;color:#f1f5f9;min-height:100vh;
  display:flex;align-items:center;justify-content:center}
.card{background:#1e293b;border:1px solid #2d3f57;border-radius:14px;padding:36px 32px;width:100%;max-width:360px}
.logo{display:flex;align-items:center;gap:10px;margin-bottom:28px}
.logo-icon{width:36px;height:36px;background:linear-gradient(135deg,#6366f1,#8b5cf6);
  border-radius:9px;display:flex;align-items:center;justify-content:center;
  font-family:monospace;font-size:14px;font-weight:800;color:#fff}
.logo-name{font-size:17px;font-weight:700}
.logo-sub{font-size:11px;color:#94a3b8;margin-top:1px}
label{display:block;font-size:11px;font-weight:700;color:#94a3b8;
  text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px;margin-top:16px}
input{width:100%;padding:9px 11px;background:#263248;border:1px solid #2d3f57;
  border-radius:8px;color:#f1f5f9;font-size:13px;outline:none;transition:border-color .15s}
input:focus{border-color:#6366f1}
.btn{margin-top:22px;width:100%;padding:10px;background:#6366f1;border:none;
  border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;transition:background .15s}
.btn:hover{background:#818cf8}
.err{margin-top:12px;font-size:12px;color:#ef4444;text-align:center;min-height:18px}
</style></head>
<body><div class="card">
  <div class="logo">
    <div class="logo-icon">Rz</div>
    <div><div class="logo-name">RazorGen</div><div class="logo-sub">Transform Builder</div></div>
  </div>
  <form method="POST" action="/auth/login">
    <label>Username</label>
    <input type="text" name="username" autocomplete="username" autofocus required>
    <label>Password</label>
    <input type="password" name="password" autocomplete="current-password" required>
    <button class="btn" type="submit">Sign in</button>
    <div class="err">{{ERROR}}</div>
  </form>
</div></body></html>`;

// ─── MIME types ───────────────────────────────────────────────────────────────
const MIME = {
  '.html':'text/html','.js':'text/javascript',
  '.css':'text/css','.json':'application/json',
  '.png':'image/png','.ico':'image/x-icon'
};

// ─── Main server ──────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  const ip  = getIp(req);
  const url = req.url.split('?')[0];

  // IP allowlist
  if (!ipAllowed(ip)) {
    res.writeHead(403, {'Content-Type':'text/plain'});
    res.end('403 Forbidden');
    console.log(`  [BLOCKED] ${ip}`);
    return;
  }

  // Login POST
  if (url === '/auth/login' && req.method === 'POST') {
    const body   = await readBody(req);
    const params = new URLSearchParams(body);
    const u = params.get('username') || '';
    const p = params.get('password') || '';
    if (USERS[u] && USERS[u] === p) {
      const token = createSession(u);
      res.writeHead(302, {
        'Set-Cookie': `rtg_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL/1000}`,
        'Location': '/'
      });
      res.end();
      console.log(`  [LOGIN] ${u} from ${ip}`);
    } else {
      res.writeHead(200, {'Content-Type':'text/html'});
      res.end(LOGIN_HTML.replace('{{ERROR}}', 'Invalid username or password'));
      console.log(`  [FAILED LOGIN] ${u} from ${ip}`);
    }
    return;
  }

  // Logout
  if (url === '/auth/logout') {
    const cookies = parseCookies(req);
    if (cookies['rtg_session']) sessions.delete(cookies['rtg_session']);
    res.writeHead(302, {
      'Set-Cookie': 'rtg_session=; HttpOnly; Path=/; Max-Age=0',
      'Location': '/login'
    });
    res.end();
    return;
  }

  // Login page
  if (url === '/login') {
    res.writeHead(200, {'Content-Type':'text/html'});
    res.end(LOGIN_HTML.replace('{{ERROR}}', ''));
    return;
  }

  // Auth gate
  if (!authed(req)) {
    res.writeHead(302, {'Location':'/login'});
    res.end();
    return;
  }

  // API proxy — key injected here, never sent to browser
  if (url === '/api/messages' && req.method === 'POST') {
    if (!API_KEY) {
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:{message:'ANTHROPIC_API_KEY not set in .env'}}));
      return;
    }
    const body = await readBody(req);
    let payload;
    try { payload = JSON.parse(body); payload.model = MODEL; }
    catch { payload = body; }
    const outBody = typeof payload === 'string' ? payload : JSON.stringify(payload);

    const proxy = https.request({
      hostname: 'api.anthropic.com', port: 443,
      path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(outBody),
        'anthropic-version': '2023-06-01',
        'x-api-key': API_KEY,
      }
    }, (apiRes) => {
      res.writeHead(apiRes.statusCode, {'Content-Type':'application/json'});
      apiRes.pipe(res);
    });
    proxy.on('error', err => {
      res.writeHead(502, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:{message:'Proxy error: '+err.message}}));
    });
    proxy.write(outBody);
    proxy.end();
    return;
  }

  // Static files
  const filePath = path.join(__dirname, url === '/' ? 'index.html' : url);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
        if (e) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, {'Content-Type':'text/html'});
        res.end(d);
      });
      return;
    }
    res.writeHead(200, {'Content-Type': MIME[path.extname(filePath)] || 'text/plain'});
    res.end(data);
  });

}).listen(PORT, '0.0.0.0', () => {
  console.log(`\n  RazorGen running at http://localhost:${PORT}`);
  console.log(`  Users: ${Object.keys(USERS).join(', ')}`);
  console.log(`  IP allowlist: ${ALLOWED_IPS.length ? ALLOWED_IPS.join(', ') : 'disabled (all IPs allowed)'}`);
  console.log();
});
