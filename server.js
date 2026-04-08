// RazorGen server.js
// - Serves the app
// - Stores the Anthropic API key server-side (never sent to browser)
// - Username/password login with session tokens
// - Optional IP allowlist
// - Runs razor-runner.exe for transform preview

const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const crypto   = require('crypto');
const { execFile } = require('child_process');

// ─── Load .env ────────────────────────────────────────────────────────────────
const ENV_PATH = path.join(__dirname, '.env');

function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) {
    console.error('\n  ERROR: .env file not found.');
    console.error('  Copy .env.example to .env and fill in your values.\n');
    process.exit(1);
  }
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
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

const PORT         = parseInt(process.env.PORT || '43000');
const SESSION_TTL  = 8 * 60 * 60 * 1000; // 8 hours
const TRUST_PROXY  = ['1','true','yes','on'].includes((process.env.TRUST_PROXY || '').trim().toLowerCase());
// On Windows the binary is razor-runner.exe; on Linux (Docker) it's razor-runner
const RUNNER_EXE = process.platform === 'win32'
  ? path.join(__dirname, 'razor-runner-dist', 'razor-runner.exe')
  : path.join(__dirname, 'razor-runner-dist', 'razor-runner');
const RUNNER_TIMEOUT_MS = parseInt(process.env.RAZOR_RUNNER_TIMEOUT_MS || '20000', 10);
const PATTERNS_PATH = path.join(__dirname, 'patterns.json');

function getConfig() {
  return {
    apiKey:        process.env.ANTHROPIC_API_KEY || '',
    model:         process.env.ANTHROPIC_MODEL   || 'claude-sonnet-4-20250514',
    allowedModels: (process.env.ANTHROPIC_ALLOWED_MODELS || [
      'claude-sonnet-4-20250514',
      'claude-opus-4-5',
      'claude-haiku-4-5-20251001',
    ].join(',')).split(',').map(s => s.trim()).filter(Boolean),
  };
}

// ─── Users ────────────────────────────────────────────────────────────────────
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
const ALLOWED_IPS = (process.env.ALLOWED_IPS || '').split(',').map(s => s.trim()).filter(Boolean);

function getIp(req) {
  const src = TRUST_PROXY ? req.headers['x-forwarded-for'] : req.socket.remoteAddress;
  return ((src || '').split(',')[0].trim());
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
async function readJsonBody(req, res) {
  const body = await readBody(req);
  try { return JSON.parse(body || '{}'); }
  catch {
    res.writeHead(400, {'Content-Type':'application/json'});
    res.end(JSON.stringify({error:{message:'Invalid JSON body'}}));
    return null;
  }
}

// ─── .env writer ─────────────────────────────────────────────────────────────
// Updates specific keys in the .env file, preserving all other content.
function writeEnvKeys(updates) {
  const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
  const written = new Set();

  const updated = lines.map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const idx = t.indexOf('=');
    if (idx === -1) return line;
    const k = t.slice(0, idx).trim();
    if (k in updates) {
      written.add(k);
      const v = updates[k];
      return v === '' ? `# ${k}=` : `${k}=${v}`;
    }
    return line;
  });

  // Append any keys not already present
  for (const [k, v] of Object.entries(updates)) {
    if (!written.has(k) && v !== '') {
      updated.push(`${k}=${v}`);
    }
  }

  fs.writeFileSync(ENV_PATH, updated.join('\n'), 'utf8');

  // Reload into process.env
  for (const [k, v] of Object.entries(updates)) {
    if (v === '') delete process.env[k];
    else process.env[k] = v;
  }
}

// ─── Transform preview via razor-runner ──────────────────────────────────────
function runPreview({ template, inputJson }) {
  return new Promise((resolve) => {
    if (!fs.existsSync(RUNNER_EXE)) {
      resolve({ ok: false, message: 'razor-runner not found. Run: dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=false -o ../razor-runner-dist in the razor-runner folder.' });
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'razorgen-'));
    const templatePath = path.join(tempDir, 'template.cshtml');
    const inputPath    = path.join(tempDir, 'input.json');

    try {
      fs.writeFileSync(templatePath, template, 'utf8');
      fs.writeFileSync(inputPath, inputJson, 'utf8');
    } catch (e) {
      resolve({ ok: false, message: 'Failed to write temp files: ' + e.message });
      return;
    }

    execFile(RUNNER_EXE, [templatePath, inputPath], {
      timeout: RUNNER_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}

      // Debug logging — remove once preview is confirmed working
      console.log('[preview] exit code:', error?.code ?? 0);
      console.log('[preview] stdout length:', stdout?.length ?? 0);
      console.log('[preview] stdout preview:', (stdout || '').slice(0, 200));
      console.log('[preview] stderr:', (stderr || '').slice(0, 500));

      // If stdout has content the template ran successfully.
      // A non-zero exit code can still occur when the .NET runtime's finalizer
      // thread crashes during cleanup after Main already returned — that is not
      // a template error. Only treat it as a failure when stdout is empty.
      if (stdout && stdout.length > 0) {
        resolve({ ok: true, output: stdout });
      } else if (error) {
        let msg = error.message;
        try { msg = JSON.parse(stderr).error; } catch {}
        resolve({ ok: false, message: msg });
      } else {
        resolve({ ok: false, message: 'No output produced' });
      }
    });
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
  '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.png':'image/png', '.ico':'image/x-icon',
};

// ─── Main server ──────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  const ip  = getIp(req);
  const url = req.url.split('?')[0];

  if (!ipAllowed(ip)) {
    res.writeHead(403, {'Content-Type':'text/plain'}); res.end('403 Forbidden');
    console.log(`  [BLOCKED] ${ip}`); return;
  }

  // ── Auth endpoints ──────────────────────────────────────────────────────────
  if (url === '/auth/login' && req.method === 'POST') {
    const body = await readBody(req);
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

  if (url === '/auth/logout') {
    const cookies = parseCookies(req);
    if (cookies['rtg_session']) sessions.delete(cookies['rtg_session']);
    res.writeHead(302, {'Set-Cookie':'rtg_session=; HttpOnly; Path=/; Max-Age=0', 'Location':'/login'});
    res.end(); return;
  }

  if (url === '/login') {
    res.writeHead(200, {'Content-Type':'text/html'});
    res.end(LOGIN_HTML.replace('{{ERROR}}', '')); return;
  }

  if (!authed(req)) {
    res.writeHead(302, {'Location':'/login'}); res.end(); return;
  }

  // ── API: server config (read) ───────────────────────────────────────────────
  if (url === '/api/config' && req.method === 'GET') {
    const cfg = getConfig();
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({
      apiKeyConfigured: !!cfg.apiKey,
      model:            cfg.model,
      allowedModels:    cfg.allowedModels,
      runnerAvailable:  fs.existsSync(RUNNER_EXE),
    }));
    return;
  }

  // ── API: settings (write) ───────────────────────────────────────────────────
  if (url === '/api/settings' && req.method === 'POST') {
    const payload = await readJsonBody(req, res);
    if (!payload) return;

    const updates = {};
    if (typeof payload.apiKey === 'string') {
      updates['ANTHROPIC_API_KEY'] = payload.apiKey.trim();
    }
    if (typeof payload.model === 'string' && payload.model.trim()) {
      updates['ANTHROPIC_MODEL'] = payload.model.trim();
    }

    if (Object.keys(updates).length === 0) {
      res.writeHead(400, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:{message:'No valid fields to update.'}}));
      return;
    }

    try {
      writeEnvKeys(updates);
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, apiKeyConfigured: !!(process.env.ANTHROPIC_API_KEY) }));
    } catch (e) {
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:{message:'Failed to save settings: ' + e.message}}));
    }
    return;
  }

  // ── API: AI generate ────────────────────────────────────────────────────────
  if (url === '/api/messages' && req.method === 'POST') {
    const cfg = getConfig();
    if (!cfg.apiKey) {
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:{message:'ANTHROPIC_API_KEY not set. Add it in Settings.'}}));
      return;
    }
    const body = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(body);
      const requested = typeof payload.model === 'string' ? payload.model.trim() : '';
      payload.model = cfg.allowedModels.includes(requested) ? requested : cfg.model;
    } catch { payload = body; }
    const outBody = typeof payload === 'string' ? payload : JSON.stringify(payload);

    const proxy = https.request({
      hostname: 'api.anthropic.com', port: 443,
      path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(outBody),
        'anthropic-version': '2023-06-01',
        'x-api-key': cfg.apiKey,
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

  // ── API: run preview ────────────────────────────────────────────────────────
  if (url === '/api/preview' && req.method === 'POST') {
    const payload = await readJsonBody(req, res);
    if (!payload) return;

    const template  = typeof payload.template  === 'string' ? payload.template.trim()  : '';
    const inputJson = typeof payload.inputJson === 'string' ? payload.inputJson.trim() : '';

    if (!template) {
      res.writeHead(400, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:{message:'template is required'}})); return;
    }
    if (!inputJson) {
      res.writeHead(400, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:{message:'inputJson is required'}})); return;
    }

    const result = await runPreview({ template, inputJson });
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify(result));
    return;
  }

  // ── API: patterns (read) ────────────────────────────────────────────────────
  if (url === '/api/patterns' && req.method === 'GET') {
    try {
      const data = fs.existsSync(PATTERNS_PATH)
        ? fs.readFileSync(PATTERNS_PATH, 'utf8')
        : '[]';
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(data);
    } catch (e) {
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:{message:e.message}}));
    }
    return;
  }

  // ── API: patterns (write) ───────────────────────────────────────────────────
  if (url === '/api/patterns' && req.method === 'POST') {
    const payload = await readJsonBody(req, res);
    if (!payload) return;
    try {
      fs.writeFileSync(PATTERNS_PATH, JSON.stringify(payload, null, 2), 'utf8');
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true}));
    } catch (e) {
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:{message:e.message}}));
    }
    return;
  }

  // ── Static files ────────────────────────────────────────────────────────────
  const reqPath  = decodeURIComponent(url === '/' ? '/index.html' : url);
  const filePath = path.resolve(__dirname, reqPath.replace(/^\/+/, ''));
  const rootDir  = path.resolve(__dirname);
  if (!filePath.startsWith(rootDir + path.sep) && filePath !== path.resolve(__dirname, 'index.html')) {
    res.writeHead(403, {'Content-Type':'text/plain'}); res.end('403 Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
        if (e) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, {'Content-Type':'text/html'}); res.end(d);
      });
      return;
    }
    res.writeHead(200, {'Content-Type': MIME[path.extname(filePath)] || 'text/plain'});
    res.end(data);
  });

}).listen(PORT, '0.0.0.0', () => {
  const cfg = getConfig();
  console.log(`\n  RazorGen running at http://localhost:${PORT}`);
  console.log(`  Users: ${Object.keys(USERS).join(', ')}`);
  console.log(`  API key: ${cfg.apiKey ? 'configured' : 'NOT SET — add in Settings'}`);
  console.log(`  Model: ${cfg.model}`);
  console.log(`  Runner: ${fs.existsSync(RUNNER_EXE) ? RUNNER_EXE : 'NOT FOUND'}`);
  console.log(`  IP allowlist: ${ALLOWED_IPS.length ? ALLOWED_IPS.join(', ') : 'disabled'}`);
  console.log();
});
