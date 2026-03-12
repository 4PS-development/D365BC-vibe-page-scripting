'use strict';

const express   = require('express');
const http      = require('http');
const { WebSocketServer, OPEN } = require('ws');
const chokidar  = require('chokidar');
const path      = require('path');
const fs        = require('fs');
const { spawn, exec } = require('child_process');
const yaml      = require('js-yaml');
const PDFDocument = require('pdfkit');

// ── Keytar (Windows Credential Manager — graceful fallback) ──────────────────
let keytar = null;
try { keytar = require('keytar'); } catch { /* use DPAPI fallback */ }

// ── Paths ─────────────────────────────────────────────────────────────────────
const ROOT      = path.resolve(__dirname, '..');
const DATA_DIR  = path.join(__dirname, '.data');
const CREDS_DIR = path.join(DATA_DIR, 'credentials');
const ENVS_FILE = path.join(DATA_DIR, 'environments.json');
const SERVICE   = 'bc-page-scripting';
const PS_EXE    = 'pwsh'; // PowerShell 7

fs.mkdirSync(DATA_DIR,  { recursive: true });
fs.mkdirSync(CREDS_DIR, { recursive: true });

// ── PowerShell helpers ────────────────────────────────────────────────────────
function runPs(cmd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PS_EXE, ['-NoProfile', '-Command', cmd], { windowsHide: true, shell: false });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `pwsh exit ${code}`)));
    proc.on('error', reject);
  });
}

function spawnPsFile(scriptPath, extraArgs = [], opts = {}) {
  return spawn(PS_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...extraArgs], {
    windowsHide: false, shell: false, ...opts,
  });
}

// ── Credential helpers ────────────────────────────────────────────────────────
function safeKey(s) { return s.replace(/[^a-zA-Z0-9:_-]/g, '_'); }

async function saveCred(account, value) {
  if (keytar) return keytar.setPassword(SERVICE, account, value);
  // Fallback: DPAPI via ConvertFrom-SecureString (machine+user specific encryption)
  const file = path.join(CREDS_DIR, safeKey(account) + '.dat');
  const escaped = value.replace(/'/g, "''");
  await runPs(`ConvertTo-SecureString '${escaped}' -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath '${file}' -NoNewline`);
}

async function readCred(account) {
  if (keytar) return keytar.getPassword(SERVICE, account);
  const file = path.join(CREDS_DIR, safeKey(account) + '.dat');
  if (!fs.existsSync(file)) return null;
  return runPs(`[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR((Get-Content -LiteralPath '${file}' | ConvertTo-SecureString)))`);
}

async function deleteCred(account) {
  if (keytar) return keytar.deletePassword(SERVICE, account);
  const file = path.join(CREDS_DIR, safeKey(account) + '.dat');
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

// ── Environment index (metadata only — no passwords) ─────────────────────────
function readEnvs() {
  try { return JSON.parse(fs.readFileSync(ENVS_FILE, 'utf8')); }
  catch { return []; }
}
function writeEnvs(envs) { fs.writeFileSync(ENVS_FILE, JSON.stringify(envs, null, 2)); }

// ── Express + WebSocket ───────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/tools', express.static(path.join(ROOT, 'tools')));
// Serve page-scripting tree so Playwright reports and screenshots are reachable
app.use('/result-files', express.static(path.join(ROOT, 'page-scripting'), { dotfiles: 'ignore' }));
app.use('/result-files-bc', express.static(path.join(ROOT, 'bc-replay', 'test-results'), { dotfiles: 'ignore' }));
app.use('/docs', express.static(path.join(ROOT, 'docs')));

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === OPEN) c.send(data); });
}

// ── File watcher — pushes file-change events to all browser clients ───────────
const watchTargets = [
  path.join(ROOT, 'page-scripting'),
  path.join(ROOT, 'bc-replay', 'test-results'),
].filter(p => fs.existsSync(p));

if (watchTargets.length) {
  chokidar.watch(watchTargets, {
    ignored: /(node_modules|\.git|Variants)/,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 500 },
  }).on('all', (event, filePath) => {
    broadcast({
      type: 'files-changed',
      event,
      path: path.relative(ROOT, filePath).replace(/\\/g, '/'),
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES — Setup
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/setup/status', async (req, res) => {
  const [major] = process.version.slice(1).split('.').map(Number);

  let psVersion = null, psOk = false;
  try { psVersion = await runPs('$PSVersionTable.PSVersion.Major'); psOk = true; } catch {}

  const chromiumPaths = [
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
    path.join(process.env.USERPROFILE  || '', 'AppData', 'Local', 'ms-playwright'),
  ];
  const chromiumInstalled = chromiumPaths.some(p => {
    if (!fs.existsSync(p)) return false;
    return fs.readdirSync(p).some(d => d.startsWith('chromium'));
  });

  res.json({
    nodeVersion: process.version,
    nodeOk: major >= 18,
    bcReplayInstalled: fs.existsSync(path.join(ROOT, 'bc-replay', 'node_modules')),
    chromiumInstalled,
    psVersion: psVersion ? `PowerShell ${psVersion}` : '(not found)',
    psOk,
    credBackend: keytar ? 'Windows Credential Manager' : 'DPAPI (encrypted local files)',
  });
});

app.post('/api/setup/install', (req, res) => {
  res.json({ ok: true });
  const proc = spawn('npm', ['install'], {
    cwd: path.join(ROOT, 'bc-replay'),
    shell: true,
    windowsHide: true,
  });
  proc.stdout.on('data', d => broadcast({ type: 'setup-output', data: d.toString() }));
  proc.stderr.on('data', d => broadcast({ type: 'setup-output', data: d.toString() }));
  proc.on('close', code => broadcast({ type: 'setup-done', code }));
});

app.post('/api/setup/install-playwright', (req, res) => {
  res.json({ ok: true });
  const proc = spawn('npx', ['playwright', 'install', 'chromium'], {
    cwd: path.join(ROOT, 'bc-replay'),
    shell: true,
    windowsHide: true,
  });
  proc.stdout.on('data', d => broadcast({ type: 'setup-output', data: d.toString() }));
  proc.stderr.on('data', d => broadcast({ type: 'setup-output', data: d.toString() }));
  proc.on('close', code => broadcast({ type: 'setup-done', code }));
});

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES — Environments & Credentials
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/environments', (_req, res) => res.json(readEnvs()));

// Get single environment with credential values (for edit modal)
app.get('/api/environments/:name', async (req, res) => {
  try {
    const env = readEnvs().find(e => e.name === req.params.name);
    if (!env) return res.status(404).json({ error: 'Not found' });

    const roles = [];
    for (const r of (env.roles || [])) {
      const username = await readCred(`${env.name}:${r.role}:username`);
      const password = await readCred(`${env.name}:${r.role}:password`);
      const mfaSeed  = await readCred(`${env.name}:${r.role}:mfa`);
      roles.push({ role: r.role, username: username || '', hasPassword: !!password, hasMfa: !!mfaSeed });
    }
    // App registration creds
    const appRegClientId     = await readCred(`${env.name}:app-reg:client_id`);
    const appRegClientSecret = await readCred(`${env.name}:app-reg:client_secret`);
    const appRegTenantId     = await readCred(`${env.name}:app-reg:tenant_id`);
    const appRegCompanyId    = await readCred(`${env.name}:app-reg:company_id`);
    const appRegCompanyName  = await readCred(`${env.name}:app-reg:company_name`);

    res.json({
      name: env.name,
      url: env.url,
      companies: env.companies || [],
      roles,
      appRegistration: {
        clientId:     appRegClientId || '',
        hasSecret:    !!appRegClientSecret,
        tenantId:     appRegTenantId || '',
        companyId:    appRegCompanyId || '',
        companyName:  appRegCompanyName || '',
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/environments', async (req, res) => {
  try {
    const { name, url, roles = [], appRegistration, companies = [] } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'name and url are required' });

    for (const r of roles) {
      if (r.password)  await saveCred(`${name}:${r.role}:password`, r.password);
      if (r.username)  await saveCred(`${name}:${r.role}:username`, r.username);
      if (r.mfaSeed)   await saveCred(`${name}:${r.role}:mfa`,      r.mfaSeed);
    }

    // Save app registration credentials
    if (appRegistration) {
      if (appRegistration.clientId)     await saveCred(`${name}:app-reg:client_id`,     appRegistration.clientId);
      if (appRegistration.clientSecret) await saveCred(`${name}:app-reg:client_secret`,  appRegistration.clientSecret);
      if (appRegistration.tenantId)     await saveCred(`${name}:app-reg:tenant_id`,      appRegistration.tenantId);
      if (appRegistration.companyId)    await saveCred(`${name}:app-reg:company_id`,     appRegistration.companyId);
      if (appRegistration.companyName)  await saveCred(`${name}:app-reg:company_name`,   appRegistration.companyName);
    }

    const envs = readEnvs().filter(e => e.name !== name);
    envs.push({
      name,
      url,
      companies: companies.filter(c => typeof c === 'string' && c.trim()).map(c => c.trim()),
      roles: roles.map(r => ({ role: r.role, username: r.username, hasMfa: !!r.mfaSeed })),
      hasAppRegistration: !!(appRegistration?.clientId),
    });
    writeEnvs(envs);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Export environment credentials to a project's users.json
app.post('/api/environments/:name/export', async (req, res) => {
  try {
    const { name } = req.params;
    const { project } = req.body;
    if (!project) return res.status(400).json({ error: 'project is required' });

    const env = readEnvs().find(e => e.name === name);
    if (!env) return res.status(404).json({ error: 'Environment not found' });

    const projectDir = path.join(ROOT, 'page-scripting', project);
    if (!fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project folder not found' });

    // Read workflow.json for bc_url (optional — include if present)
    let bcUrl = env.url || '';
    const wfPath = path.join(projectDir, 'workflow.json');
    if (fs.existsSync(wfPath)) {
      try {
        const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
        if (wf.bc_url) bcUrl = wf.bc_url;
      } catch { /* use env url */ }
    }

    // Build users object from credential store
    const users = {};
    for (const r of env.roles || []) {
      const username = await readCred(`${name}:${r.role}:username`);
      const password = await readCred(`${name}:${r.role}:password`);
      const mfaSeed  = await readCred(`${name}:${r.role}:mfa`);
      users[r.role] = {};
      if (username) users[r.role].username = username;
      if (password) users[r.role].password = password;
      if (mfaSeed)  users[r.role].mfa_seed = mfaSeed;
    }

    const usersPath = path.join(projectDir, 'users.json');
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));

    res.json({ ok: true, path: path.relative(ROOT, usersPath).replace(/\\/g, '/'), roles: Object.keys(users) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/environments/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const env = readEnvs().find(e => e.name === name);
    if (env) {
      for (const r of env.roles || []) {
        await deleteCred(`${name}:${r.role}:password`);
        await deleteCred(`${name}:${r.role}:username`);
        await deleteCred(`${name}:${r.role}:mfa`);
      }
      // Clean up app registration creds
      await deleteCred(`${name}:app-reg:client_id`);
      await deleteCred(`${name}:app-reg:client_secret`);
      await deleteCred(`${name}:app-reg:tenant_id`);
      await deleteCred(`${name}:app-reg:company_id`);
      await deleteCred(`${name}:app-reg:company_name`);
    }
    writeEnvs(readEnvs().filter(e => e.name !== name));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES — BC API proxy (fetch companies for app registration setup)
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/bc/companies', async (req, res) => {
  const { clientId, clientSecret, tenantId, bcUrl } = req.body;
  if (!clientId || !clientSecret || !tenantId) {
    return res.status(400).json({ error: 'clientId, clientSecret, and tenantId are required' });
  }

  try {
    // Get OAuth token via client_credentials
    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const tokenBody = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://api.businesscentral.dynamics.com/.default',
    });
    const tokenRes = await fetch(tokenUrl, { method: 'POST', body: tokenBody });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      return res.status(401).json({ error: tokenData.error_description || 'OAuth token request failed' });
    }

    // Extract environment name from BC URL
    let envName = 'Production';
    if (bcUrl) {
      const match = bcUrl.match(/bc\.dynamics\.com\/[0-9a-f-]+\/(\w+)/i);
      if (match) envName = match[1];
    }

    // Fetch companies list from BC API
    const companiesUrl = `https://api.businesscentral.dynamics.com/v2.0/${tenantId}/${envName}/api/v2.0/companies`;
    const companiesRes = await fetch(companiesUrl, {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
    });
    const companiesData = await companiesRes.json();
    if (!companiesRes.ok) {
      return res.status(companiesRes.status).json({ error: companiesData?.error?.message || 'Failed to fetch companies' });
    }

    const companies = (companiesData.value || []).map(c => ({
      id: c.id,
      name: c.name,
      displayName: c.displayName,
    }));
    res.json({ companies, environmentName: envName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES — Projects & Scripts
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/projects', (_req, res) => {
  const psDir = path.join(ROOT, 'page-scripting');
  try {
    const entries = fs.readdirSync(psDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({
        name: e.name,
        hasWorkflow: fs.existsSync(path.join(psDir, e.name, 'workflow.json')),
      }));
    res.json(entries);
  } catch { res.json([]); }
});

app.get('/api/projects/:name/scripts', (req, res) => {
  const projectDir = path.join(ROOT, 'page-scripting', req.params.name);
  const collect = (dir) => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => /\.ya?ml$/i.test(f))
      .map(f => {
        const fullPath = path.join(dir, f);
        return {
          name: f,
          relativePath: path.relative(projectDir, fullPath).replace(/\\/g, '/'),
          content: fs.readFileSync(fullPath, 'utf8')
        };
      });
  };
  res.json([
    ...collect(path.join(projectDir, 'scripts')),
    ...collect(projectDir),
  ]);
});

app.get('/api/projects/:name/workflow', (req, res) => {
  const wfPath = path.join(ROOT, 'page-scripting', req.params.name, 'workflow.json');
  if (!fs.existsSync(wfPath)) return res.status(404).json({ error: 'workflow.json not found' });
  res.json(JSON.parse(fs.readFileSync(wfPath, 'utf8')));
});

app.get('/api/projects/:name/users', (req, res) => {
  const projDir = path.join(ROOT, 'page-scripting', req.params.name);
  // Prefer the real users.json over the sample
  const candidates = ['users.json', 'users.sample.json'];
  for (const fname of candidates) {
    const p = path.join(projDir, fname);
    if (fs.existsSync(p)) {
      try { return res.json(JSON.parse(fs.readFileSync(p, 'utf8'))); }
      catch { break; }
    }
  }
  res.status(404).json({ error: 'No users file found' });
});

app.post('/api/projects/:name/workflow', (req, res) => {
  const projDir = path.join(ROOT, 'page-scripting', req.params.name);
  fs.mkdirSync(projDir, { recursive: true });
  const wfPath = path.join(projDir, 'workflow.json');
  fs.writeFileSync(wfPath, JSON.stringify(req.body, null, 2));
  res.json({ ok: true, path: path.relative(ROOT, wfPath).replace(/\\/g, '/') });
});

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES — Variant Generation
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/variants/generate', (req, res) => {
  const { project, baseScript, items, locations } = req.body;
  if (!project || !baseScript) return res.status(400).json({ error: 'project and baseScript are required' });

  const projectDir  = path.join(ROOT, 'page-scripting', project);
  const baseScriptPath = path.join(projectDir, baseScript);
  const outputFolder   = path.join(projectDir, 'Variants');
  const tempDir        = path.join(DATA_DIR, `temp-${Date.now()}`);

  try {
    fs.mkdirSync(tempDir, { recursive: true });
    if (items)     fs.writeFileSync(path.join(tempDir, 'Items'),     items.split('\n').filter(Boolean).join('\r\n'));
    if (locations) fs.writeFileSync(path.join(tempDir, 'Locations'), locations.split('\n').filter(Boolean).join('\r\n'));
  } catch (e) {
    return res.status(500).json({ error: `Could not write temp data files: ${e.message}` });
  }

  res.json({ ok: true });

  const psScript = path.join(ROOT, 'page-scripting', 'Generate-BC-Script-Variants.ps1');
  const proc = spawnPsFile(psScript, [
    '-BaseScriptPath', baseScriptPath,
    '-ProjectFolder',  tempDir,
    '-OutputFolder',   outputFolder,
  ]);

  proc.stdout.on('data', d => broadcast({ type: 'variant-output', data: d.toString() }));
  proc.stderr.on('data', d => broadcast({ type: 'variant-output', data: d.toString() }));
  proc.on('close', code => {
    broadcast({ type: 'variant-done', code, outputFolder: path.relative(ROOT, outputFolder).replace(/\\/g, '/') });
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });
  proc.on('error', e => broadcast({ type: 'variant-done', code: 1, error: e.message }));
});

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES — Run Workflow
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/run', async (req, res) => {
  const { project, environment, headed, stopOnFailure, dryRun } = req.body;
  if (!project) return res.status(400).json({ error: 'project is required' });

  // Build a temporary users.json from the credential store
  let tempUsersPath = null;
  try {
    const envMeta = readEnvs().find(e => e.name === environment);
    const users = {};

    if (envMeta) {
      for (const r of envMeta.roles || []) {
        const username = await readCred(`${environment}:${r.role}:username`);
        const password = await readCred(`${environment}:${r.role}:password`);
        const mfaSeed  = await readCred(`${environment}:${r.role}:mfa`);
        users[r.role] = { username, password };
        if (mfaSeed) users[r.role].mfa_seed = mfaSeed;
      }
    }

    tempUsersPath = path.join(DATA_DIR, `users-${Date.now()}.json`);
    fs.writeFileSync(tempUsersPath, JSON.stringify(users, null, 2));
  } catch (e) {
    return res.status(500).json({ error: `Could not resolve credentials: ${e.message}` });
  }

  res.json({ ok: true });

  const psScript = path.join(ROOT, 'bc-replay', 'Run-BCWorkflow.ps1');
  const projectPath = path.join(ROOT, 'page-scripting', project);
  const extraArgs = ['-WorkflowPath', projectPath, '-UsersPath', tempUsersPath];

  if (headed)          extraArgs.push('-Headed');
  if (dryRun)          extraArgs.push('-DryRun');
  if (stopOnFailure === false) extraArgs.push('-StopOnFailure:$false');

  const proc = spawnPsFile(psScript, extraArgs, { cwd: path.join(ROOT, 'bc-replay') });
  proc.stdout.on('data', d => broadcast({ type: 'run-output', data: d.toString() }));
  proc.stderr.on('data', d => broadcast({ type: 'run-output', data: d.toString() }));
  proc.on('close', code => {
    broadcast({ type: 'run-done', code });
    try { if (tempUsersPath) fs.unlinkSync(tempUsersPath); } catch {}
  });
  proc.on('error', e => {
    broadcast({ type: 'run-done', code: 1, error: e.message });
    try { if (tempUsersPath) fs.unlinkSync(tempUsersPath); } catch {}
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES — Seed environment from project files (users.json + workflow.json)
// ══════════════════════════════════════════════════════════════════════════════

// Returns info about what would be seeded — lets the UI show a preview
app.get('/api/projects/:name/seed-info', (req, res) => {
  const projectDir = path.join(ROOT, 'page-scripting', req.params.name);
  const wfPath     = path.join(projectDir, 'workflow.json');
  const usersPath  = path.join(projectDir, 'users.json');

  if (!fs.existsSync(wfPath))    return res.status(404).json({ error: 'workflow.json not found in project' });
  if (!fs.existsSync(usersPath)) return res.status(404).json({ error: 'users.json not found in project' });

  try {
    const wf    = JSON.parse(fs.readFileSync(wfPath,    'utf8'));
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    const roles = Object.entries(users).map(([role, info]) => ({
      role,
      username:   info.username || '',
      hasPassword: !!(info.password),
      hasMfa:      !!(info.mfa_seed),
    }));
    res.json({ envName: req.params.name, bc_url: wf.bc_url || '', roles });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Actually seeds the environment — reads credentials from users.json and saves to Credential Manager
app.post('/api/projects/:name/seed', async (req, res) => {
  const projectDir = path.join(ROOT, 'page-scripting', req.params.name);
  const wfPath     = path.join(projectDir, 'workflow.json');
  const usersPath  = path.join(projectDir, 'users.json');

  if (!fs.existsSync(wfPath))    return res.status(404).json({ error: 'workflow.json not found' });
  if (!fs.existsSync(usersPath)) return res.status(404).json({ error: 'users.json not found' });

  try {
    const wf    = JSON.parse(fs.readFileSync(wfPath,    'utf8'));
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));

    const envName = req.params.name;
    const url     = wf.bc_url || '';

    // Save each role's credentials to the secure store
    for (const [role, info] of Object.entries(users)) {
      if (info.username) await saveCred(`${envName}:${role}:username`, info.username);
      if (info.password) await saveCred(`${envName}:${role}:password`, info.password);
      if (info.mfa_seed) await saveCred(`${envName}:${role}:mfa`,      info.mfa_seed);
    }

    // Upsert the environment metadata (preserve existing entries)
    const roles = Object.entries(users).map(([role, info]) => ({
      role,
      username: info.username || '',
      hasMfa:   !!(info.mfa_seed),
    }));
    const envs = readEnvs().filter(e => e.name !== envName);
    envs.push({ name: envName, url, roles });
    writeEnvs(envs);

    res.json({ ok: true, envName, url, rolesSeeded: roles.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES — Scaffold new project from Workflow Builder
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/projects/scaffold', (req, res) => {
  const { projectName, workflow, users, appRegistrations, scripts = [] } = req.body;
  if (!projectName) return res.status(400).json({ error: 'projectName is required' });
  if (!workflow)    return res.status(400).json({ error: 'workflow is required' });

  // Prevent path traversal — keep only the final path segment and strip illegal chars
  const safeName = path.basename(projectName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim();
  if (!safeName) return res.status(400).json({ error: 'Invalid project name' });

  const projDir    = path.join(ROOT, 'page-scripting', safeName);
  const scriptsDir = path.join(projDir, 'scripts');

  try {
    fs.mkdirSync(scriptsDir, { recursive: true });

    // workflow.json
    fs.writeFileSync(path.join(projDir, 'workflow.json'), JSON.stringify(workflow, null, 2));

    // users.sample.json
    if (users) {
      fs.writeFileSync(path.join(projDir, 'users.sample.json'), JSON.stringify(users, null, 2));
    }

    // app-registrations.sample.json (only when API steps present)
    if (appRegistrations) {
      fs.writeFileSync(path.join(projDir, 'app-registrations.sample.json'), JSON.stringify(appRegistrations, null, 2));
    }

    // .yml script files → scripts/
    const savedScripts = [];
    for (const { name, content } of scripts) {
      if (!name || !content) continue;
      const safeFName = path.basename(name);
      fs.writeFileSync(path.join(scriptsDir, safeFName), content);
      savedScripts.push(safeFName);
    }

    res.json({
      ok: true,
      projectName: safeName,
      projectPath: path.relative(ROOT, projDir).replace(/\\/g, '/'),
      savedScripts,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES — Evaluate Workflow Quality
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/evaluate', (req, res) => {
  const { project } = req.body;
  if (!project) return res.status(400).json({ error: 'project is required' });

  const projectPath = path.join(ROOT, 'page-scripting', project);
  const wfPath = path.join(projectPath, 'workflow.json');
  if (!fs.existsSync(wfPath)) return res.status(404).json({ error: 'workflow.json not found in project' });

  const outputPath = path.join(projectPath, 'results');
  res.json({ ok: true });

  const psScript = path.join(ROOT, 'bc-replay', 'Test-WorkflowQuality.ps1');
  const proc = spawnPsFile(psScript, [
    '-WorkflowPath', projectPath,
    '-OutputPath', outputPath,
  ]);

  proc.stdout.on('data', d => broadcast({ type: 'evaluate-output', data: d.toString() }));
  proc.stderr.on('data', d => broadcast({ type: 'evaluate-output', data: d.toString() }));
  proc.on('close', code => {
    // Read the JSON report if available
    let report = null;
    const jsonReport = path.join(outputPath, 'evaluation-report.json');
    const htmlReport = path.join(outputPath, 'evaluation-report.html');
    try { if (fs.existsSync(jsonReport)) report = JSON.parse(fs.readFileSync(jsonReport, 'utf8')); } catch {}
    const htmlUrl = fs.existsSync(htmlReport)
      ? `/result-files/${encodeURIComponent(project)}/results/evaluation-report.html`
      : null;
    broadcast({ type: 'evaluate-done', code, report, htmlUrl });
  });
  proc.on('error', e => broadcast({ type: 'evaluate-done', code: 1, error: e.message }));
});

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES — Results
// ══════════════════════════════════════════════════════════════════════════════

// Recursively find all workflow-summary.json files under a root dir
function findSummaries(dir, base, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findSummaries(full, base, results);
    } else if (entry.name === 'workflow-summary.json') {
      try {
        const data = JSON.parse(fs.readFileSync(full, 'utf8'));
        const rel  = path.relative(base, path.dirname(full)).replace(/\\/g, '/');
        results.push({
          id:           rel,
          source:       'page-scripting',
          path:         full,
          relDir:       rel,
          workflow_name: data.workflow_name || rel,
          overall:      data.overall || 'UNKNOWN',
          start_time:   data.start_time,
          end_time:     data.end_time,
          duration_s:   data.duration_s,
          total_steps:  data.total_steps,
          passed:       data.passed,
          failed:       data.failed,
          skipped:      data.skipped,
        });
      } catch { /* skip corrupt files */ }
    }
  }
  return results;
}

// Delete all result directories (reset)
app.delete('/api/results', (_req, res) => {
  const psBase = path.join(ROOT, 'page-scripting');
  let deleted = 0;
  try {
    const entries = fs.readdirSync(psBase, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const resultsDir = path.join(psBase, entry.name, 'results');
      if (fs.existsSync(resultsDir)) {
        fs.rmSync(resultsDir, { recursive: true, force: true });
        deleted++;
      }
    }
    res.json({ ok: true, deleted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List all available run summaries
app.get('/api/results', (_req, res) => {
  const psBase    = path.join(ROOT, 'page-scripting');
  const summaries = findSummaries(psBase, psBase);
  summaries.sort((a, b) => new Date(b.start_time || 0) - new Date(a.start_time || 0));
  res.json(summaries);
});

// Full summary detail (steps etc.) for one run — id is a slash-separated relative path
app.get('/api/results/detail', (req, res) => {
  const relDir = req.query.id;
  if (!relDir) return res.status(400).json({ error: 'id query param required' });
  const summaryPath = path.join(ROOT, 'page-scripting', relDir, 'workflow-summary.json');
  if (!fs.existsSync(summaryPath)) return res.status(404).json({ error: 'Not found' });
  try {
    const data = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    // Annotate each step with a URL to its Playwright report (served via /result-files)
    if (Array.isArray(data.steps)) {
      data.steps = data.steps.map(step => {
        const reportIndexAbs = step.report_dir
          ? path.join(step.report_dir, 'playwright-report', 'index.html')
          : null;
        let reportUrl = null;
        if (reportIndexAbs && fs.existsSync(reportIndexAbs)) {
          // Convert absolute path to a /result-files/ URL
          const rel = path.relative(path.join(ROOT, 'page-scripting'), reportIndexAbs).replace(/\\/g, '/');
          reportUrl = '/result-files/' + rel;
        }
        // Screenshots: look for attachments folder next to playwright-report
        const attachDir = step.report_dir ? path.join(step.report_dir, 'attachments') : null;
        const screenshots = [];
        if (attachDir && fs.existsSync(attachDir)) {
          fs.readdirSync(attachDir)
            .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
            .forEach(f => {
              const rel = path.relative(path.join(ROOT, 'page-scripting'), path.join(attachDir, f)).replace(/\\/g, '/');
              screenshots.push('/result-files/' + rel);
            });
        }
        return { ...step, reportUrl, screenshots };
      });
    }
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES — Step detail data (Playwright report YAMLs)
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/results/step-data', (req, res) => {
  const reportDir = req.query.dir;
  if (!reportDir) return res.status(400).json({ error: 'dir query param required' });

  const dataDir = path.join(reportDir, 'playwright-report', 'data');
  if (!fs.existsSync(dataDir)) return res.status(404).json({ error: 'No playwright-report/data found' });

  try {
    const ymlFiles = fs.readdirSync(dataDir).filter(f => /\.ya?ml$/i.test(f));
    let testDef = null;
    let execLog = null;

    for (const f of ymlFiles) {
      const content = yaml.load(fs.readFileSync(path.join(dataDir, f), 'utf8'));
      if (content && content.name && content.steps) {
        testDef = content; // test definition (has name + steps without log)
      } else if (content && content.steps && content.steps[0]?.log) {
        execLog = content; // execution log (has steps with log.start/duration)
      }
    }

    // Merge: combine test def descriptions with execution timing
    const steps = [];
    const defSteps = testDef?.steps || [];
    const logSteps = execLog?.steps || [];
    const maxLen = Math.max(defSteps.length, logSteps.length);

    for (let i = 0; i < maxLen; i++) {
      const ds = defSteps[i] || {};
      const ls = logSteps[i] || {};
      // Clean up description HTML tags
      const desc = (ls.description || ds.description || '').replace(/<[^>]+>/g, '');
      steps.push({
        index: i + 1,
        type:        ls.type || ds.type || '',
        description: desc,
        target:      ds.target || ls.target || null,
        value:       ds.value || ls.value || null,
        start:       ls.log?.start || null,
        duration_ms: ls.log?.duration ?? null,
      });
    }

    res.json({
      name: testDef?.name || '',
      telemetryId: testDef?.telemetryId || execLog?.telemetryId || '',
      totalSteps: steps.length,
      steps,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES — PDF Report
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/results/pdf', (req, res) => {
  const relDir = req.query.id;
  if (!relDir) return res.status(400).json({ error: 'id query param required' });
  const summaryPath = path.join(ROOT, 'page-scripting', relDir, 'workflow-summary.json');
  if (!fs.existsSync(summaryPath)) return res.status(404).json({ error: 'Not found' });

  try {
    const data = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));

    // Load captured values from workflow-state.json if present
    let capturedState = {};
    const statePath = path.join(ROOT, 'page-scripting', relDir, 'workflow-state.json');
    if (fs.existsSync(statePath)) {
      try { capturedState = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
    }

    // Parse results.xml for failure messages
    function parseStepFailures(reportDir) {
      if (!reportDir) return [];
      const xmlPath = path.join(reportDir, 'results.xml');
      if (!fs.existsSync(xmlPath)) return [];
      const xml = fs.readFileSync(xmlPath, 'utf8');
      const failures = [];
      for (const m of xml.matchAll(/<failure[^>]*>([\s\S]*?)<\/failure>/g)) {
        failures.push(m[1].trim().substring(0, 600));
      }
      return failures;
    }

    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="report-${relDir.replace(/\//g, '-')}.pdf"`);
    doc.pipe(res);

    // ── Constants ────────────────────────────────────────────────────────
    const L = 50, W = 495;
    const C_BRAND  = '#e4002b';
    const C_PASS   = '#1a7a3f';
    const C_FAIL   = '#c0392b';
    const C_SKIP   = '#666666';
    const C_DARK   = '#1a1a1a';
    const C_MID    = '#444444';
    const C_LIGHT  = '#888888';
    const C_RULE   = '#dddddd';
    const C_HEADBG = '#1a1a1a';

    const overall      = data.overall || 'UNKNOWN';
    const overallColor = overall === 'PASSED' ? C_PASS : overall === 'FAILED' ? C_FAIL : C_SKIP;
    const total        = Math.max(data.total_steps || 1, 1);

    function hr(y) {
      doc.moveTo(L, y).lineTo(L + W, y).strokeColor(C_RULE).lineWidth(0.5).stroke();
    }

    function sectionTitle(text) {
      doc.moveDown(0.8);
      doc.font('Helvetica-Bold').fontSize(11).fillColor(C_DARK).text(text, L);
      doc.moveDown(0.4);
    }

    function twoColRow(la, va, lb, vb, y) {
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C_LIGHT).text(la, L + 4,   y, { width: 65 });
      doc.font('Helvetica')     .fontSize(8.5).fillColor(C_DARK) .text(va, L + 70,  y, { width: W / 2 - 80 });
      if (lb !== undefined) {
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C_LIGHT).text(lb, L + W / 2 + 10, y, { width: 65 });
        doc.font('Helvetica')     .fontSize(8.5).fillColor(C_DARK) .text(vb, L + W / 2 + 76, y, { width: W / 2 - 80 });
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // PAGE 1 — SUMMARY
    // ══════════════════════════════════════════════════════════════════════

    // Brand bar
    doc.rect(L, 50, W, 4).fill(C_BRAND);

    // Header
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C_BRAND)
      .text('4PS TEST AUTOMATION', L, 66, { width: W, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(22).fillColor(C_DARK).text('Test Execution Report', L, 64);
    doc.font('Helvetica').fontSize(12).fillColor(C_MID).text(data.workflow_name || relDir, L, 90);
    doc.font('Helvetica').fontSize(8.5).fillColor(C_LIGHT)
      .text('Generated: ' + new Date().toLocaleString('en-GB'), L, 106);
    doc.y = 120;

    hr(doc.y); doc.moveDown(0.8);

    // Overall status pill
    const pillY = doc.y;
    doc.roundedRect(L, pillY, 170, 48, 6).fill(overallColor);
    doc.font('Helvetica-Bold').fontSize(24).fillColor('#fff')
      .text(overall, L, pillY + 11, { width: 170, align: 'center' });
    doc.y = pillY + 64;

    // Run metadata (2-col)
    const mdRows = [
      ['Start',    data.start_time ? new Date(data.start_time).toLocaleString('en-GB') : 'N/A',
       'End',      data.end_time   ? new Date(data.end_time).toLocaleString('en-GB')   : 'N/A'],
      ['Duration', (data.duration_s != null ? data.duration_s + ' s' : 'N/A'),
       'Total Steps', String(data.total_steps ?? 0)],
    ];
    for (const row of mdRows) {
      twoColRow(row[0], row[1], row[2], row[3], doc.y);
      doc.y += 16;
    }

    doc.moveDown(0.6); hr(doc.y); doc.moveDown(0.8);

    // Result breakdown
    sectionTitle('Result Breakdown');
    const barStats = [
      { label: 'Passed',  value: data.passed  ?? 0, color: C_PASS },
      { label: 'Failed',  value: data.failed  ?? 0, color: C_FAIL },
      { label: 'Skipped', value: data.skipped ?? 0, color: C_SKIP },
    ];
    const barY = doc.y, barH = 18;
    let bx = L;
    for (const s of barStats) {
      const sw = Math.max(Math.round((s.value / total) * W), s.value > 0 ? 6 : 0);
      if (sw > 0) { doc.rect(bx, barY, sw, barH).fill(s.color); bx += sw; }
    }
    // Remaining fill
    if (bx < L + W) doc.rect(bx, barY, L + W - bx, barH).fill('#f0f0f0');
    doc.y = barY + barH + 8;

    // Legend
    barStats.forEach((s, i) => {
      const lx = L + i * 120;
      doc.rect(lx, doc.y + 2, 10, 10).fill(s.color);
      doc.font('Helvetica').fontSize(9).fillColor(C_DARK)
        .text(`${s.label}: ${s.value}`, lx + 14, doc.y, { width: 100 });
    });
    doc.y += 18;

    // Captured values
    const capturedEntries = Object.entries(capturedState);
    if (capturedEntries.length) {
      doc.moveDown(0.6); hr(doc.y);
      sectionTitle('Captured Values');
      for (const [stepId, vals] of capturedEntries) {
        const stepName = data.steps?.find(s => s.id === stepId)?.name || stepId;
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C_MID).text(stepName, L + 4);
        doc.moveDown(0.2);
        for (const [k, v] of Object.entries(vals)) {
          doc.font('Courier').fontSize(8.5).fillColor(C_DARK).text(`  ${k}:  ${v}`, L + 16);
        }
        doc.moveDown(0.4);
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // PAGE 2 — STEPS OVERVIEW TABLE
    // ══════════════════════════════════════════════════════════════════════

    doc.addPage();
    doc.rect(L, 50, W, 4).fill(C_BRAND);
    doc.font('Helvetica-Bold').fontSize(14).fillColor(C_DARK).text('Steps Overview', L, 66);
    doc.font('Helvetica').fontSize(8.5).fillColor(C_LIGHT)
      .text(data.workflow_name || '', L, 69, { width: W, align: 'right' });
    doc.y = 92;

    if (Array.isArray(data.steps) && data.steps.length) {
      const cx = [L, L+80, L+265, L+350, L+425];
      const cw = [76, 181,  80,    70,    70];

      // Table header
      const thY = doc.y;
      doc.rect(L, thY, W, 18).fill(C_HEADBG);
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8);
      ['STEP ID','NAME','USER','STATUS','DURATION'].forEach((h, i) => {
        doc.text(h, cx[i]+3, thY+5, { width: cw[i] });
      });
      doc.y = thY + 22;
      doc.fillColor(C_DARK);

      let rowBg = true;
      for (const step of data.steps) {
        if (doc.y > 765) {
          doc.addPage();
          doc.rect(L, 50, W, 4).fill(C_BRAND);
          doc.y = 64;
        }
        const sy   = doc.y;
        const st   = step.status || 'unknown';
        const sc   = st === 'passed' ? C_PASS : st === 'failed' ? C_FAIL : C_SKIP;
        doc.rect(L, sy, W, 17).fill(rowBg ? '#f8f8f8' : '#ffffff');
        doc.moveTo(L, sy).lineTo(L+W, sy).strokeColor(C_RULE).lineWidth(0.3).stroke();
        doc.font('Courier')   .fontSize(8).fillColor(C_MID) .text(step.id   ||'', cx[0]+3, sy+4, { width: cw[0] });
        doc.font('Helvetica') .fontSize(8).fillColor(C_DARK).text(step.name ||'', cx[1]+3, sy+4, { width: cw[1] });
        doc.font('Helvetica') .fontSize(8).fillColor(C_MID) .text(step.user ||'', cx[2]+3, sy+4, { width: cw[2] });
        doc.font('Helvetica-Bold').fontSize(8).fillColor(sc).text(st.toUpperCase(), cx[3]+3, sy+4, { width: cw[3] });
        doc.font('Helvetica') .fontSize(8).fillColor(C_DARK)
          .text(step.duration_s != null ? step.duration_s+'s' : '-', cx[4]+3, sy+4, { width: cw[4] });
        doc.y = sy + 19;
        rowBg = !rowBg;

        // Sub-results
        if (step.sub_results?.length) {
          for (const sub of step.sub_results) {
            if (doc.y > 765) { doc.addPage(); doc.y = 64; }
            const ssy = doc.y;
            const sst  = sub.status || 'unknown';
            const ssc  = sst === 'passed' ? C_PASS : sst === 'failed' ? C_FAIL : C_SKIP;
            doc.rect(L, ssy, W, 14).fill('#f0f0f0');
            doc.font('Helvetica').fontSize(7.5).fillColor(C_LIGHT)
              .text('  ↳ ' + (sub.label || sub.script || ''), cx[1]+10, ssy+3, { width: 160 });
            doc.font('Helvetica-Bold').fontSize(7.5).fillColor(ssc)
              .text(sst.toUpperCase(), cx[3]+3, ssy+3, { width: cw[3] });
            doc.font('Helvetica').fontSize(7.5).fillColor(C_DARK)
              .text(sub.duration_s != null ? sub.duration_s+'s' : '-', cx[4]+3, ssy+3, { width: cw[4] });
            doc.y = ssy + 16;
          }
        }
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // APPENDIX — STEP DETAILS
    // ══════════════════════════════════════════════════════════════════════

    if (Array.isArray(data.steps) && data.steps.length) {
      doc.addPage();
      doc.rect(L, 50, W, 4).fill(C_BRAND);
      doc.font('Helvetica-Bold').fontSize(16).fillColor(C_DARK).text('Appendix — Step Details', L, 64);
      doc.font('Helvetica').fontSize(8.5).fillColor(C_LIGHT)
        .text(data.workflow_name || '', L, 68, { width: W, align: 'right' });
      doc.y = 96;

      for (let si = 0; si < data.steps.length; si++) {
        const step      = data.steps[si];
        const st        = step.status || 'unknown';
        const sc        = st === 'passed' ? C_PASS : st === 'failed' ? C_FAIL : C_SKIP;
        const failures  = parseStepFailures(step.report_dir);
        const captured  = capturedState[step.id] ? Object.entries(capturedState[step.id]) : [];

        if (doc.y > 690) {
          doc.addPage();
          doc.rect(L, 50, W, 4).fill(C_BRAND);
          doc.y = 64;
        }

        // Step header bar
        const shY = doc.y;
        doc.rect(L, shY, W, 26).fill(sc);
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#fff')
          .text(`Step ${si + 1}: ${step.name || step.id}`, L + 8, shY + 8, { width: W - 110 });
        doc.font('Helvetica-Bold').fontSize(9).fillColor('rgba(255,255,255,0.85)')
          .text(st.toUpperCase(), L + W - 70, shY + 10, { width: 64, align: 'right' });
        doc.y = shY + 32;

        // Metadata (2-col)
        const mdPairs = [
          ['ID',        step.id || '-',         'User',       step.user || '-'],
          ['Start',     step.start_time  ? new Date(step.start_time).toLocaleString('en-GB')  : '-',
           'End',       step.end_time    ? new Date(step.end_time).toLocaleString('en-GB')    : '-'],
          ['Duration',  step.duration_s != null ? step.duration_s + ' s' : '-',
           'Exit Code', String(step.exit_code ?? '-')],
        ];
        for (const row of mdPairs) {
          twoColRow(row[0], row[1], row[2], row[3], doc.y);
          doc.y += 14;
        }
        doc.moveDown(0.3);

        // Captured values for this step
        if (captured.length) {
          doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C_MID).text('Captured Values', L + 4);
          doc.moveDown(0.2);
          for (const [k, v] of captured) {
            doc.font('Courier').fontSize(8.5).fillColor(C_DARK).text(`  ${k}: ${v}`, L + 16);
          }
          doc.moveDown(0.4);
        }

        // Sub-results
        if (step.sub_results?.length) {
          doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C_MID).text('Sub-Results', L + 4);
          doc.moveDown(0.2);
          for (const sub of step.sub_results) {
            if (doc.y > 770) { doc.addPage(); doc.y = 64; }
            const sst  = sub.status || 'unknown';
            const ssc  = sst === 'passed' ? C_PASS : sst === 'failed' ? C_FAIL : C_SKIP;
            const dur  = sub.duration_s != null ? `  (${sub.duration_s}s)` : '';
            doc.font('Helvetica').fontSize(8.5).fillColor(C_DARK)
              .text(`  • ${sub.label || sub.script || ''}${dur}`, L + 16, doc.y, { width: W - 110, continued: true });
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor(ssc)
              .text(`  ${sst.toUpperCase()}`, { continued: false });
          }
          doc.moveDown(0.4);
        }

        // Failure details
        if (failures.length) {
          doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C_FAIL).text('Failure Details', L + 4);
          doc.moveDown(0.2);
          for (const f of failures) {
            if (doc.y > 750) { doc.addPage(); doc.y = 64; }
            doc.font('Courier').fontSize(7.5).fillColor(C_FAIL).text(f, L + 16, doc.y, { width: W - 24 });
            doc.moveDown(0.3);
          }
        }

        doc.moveDown(0.4);
        hr(doc.y);
        doc.moveDown(0.8);
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // PAGE NUMBERS
    // ══════════════════════════════════════════════════════════════════════

    const numPages = doc.bufferedPageRange().count;
    for (let i = 0; i < numPages; i++) {
      doc.switchToPage(i);
      doc.font('Helvetica').fontSize(7).fillColor(C_LIGHT)
        .text(
          `4PS Test Automation  •  ${data.workflow_name || ''}  •  Page ${i + 1} of ${numPages}`,
          L, 823, { width: W, align: 'center' }
        );
    }

    doc.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES — Dependency Health Check
// ══════════════════════════════════════════════════════════════════════════════

function checkDeps() {
  const bcReplayMods = path.join(ROOT, 'bc-replay', 'node_modules');
  const bcReplayPkg  = path.join(bcReplayMods, '@microsoft', 'bc-replay', 'package.json');
  const chromiumPaths = [
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
    path.join(process.env.USERPROFILE  || '', 'AppData', 'Local', 'ms-playwright'),
  ];

  const bcReplayInstalled = fs.existsSync(bcReplayMods);
  const bcReplayVersion   = bcReplayInstalled && fs.existsSync(bcReplayPkg)
    ? (() => { try { return JSON.parse(fs.readFileSync(bcReplayPkg, 'utf8')).version; } catch { return null; } })()
    : null;
  const chromiumInstalled = chromiumPaths.some(p => {
    if (!fs.existsSync(p)) return false;
    return fs.readdirSync(p).some(d => d.startsWith('chromium'));
  });

  return {
    bcReplayInstalled,
    bcReplayVersion,
    chromiumInstalled,
    allOk: bcReplayInstalled && chromiumInstalled,
  };
}

app.get('/api/health/deps', (_req, res) => {
  res.json(checkDeps());
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3333;
server.listen(PORT, '127.0.0.1', () => {
  // Warn about missing deps at startup
  const deps = checkDeps();
  if (!deps.allOk) {
    console.log('');
    if (!deps.bcReplayInstalled)
      console.warn('  [WARN] bc-replay dependencies not installed. Run: cd bc-replay && npm install');
    if (!deps.chromiumInstalled)
      console.warn('  [WARN] Playwright Chromium not found. Run: cd bc-replay && npx playwright install chromium');
  }
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log('  4PS Test Automation');
  console.log(`  Running at: ${url}`);
  console.log('');
  // Open in default browser (Windows)
  exec(`start ${url}`, { shell: true });
});

process.on('SIGINT', () => { wss.close(); server.close(); process.exit(0); });
