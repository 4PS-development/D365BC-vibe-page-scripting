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

  res.json({
    nodeVersion: process.version,
    nodeOk: major >= 18,
    bcReplayInstalled: fs.existsSync(path.join(ROOT, 'bc-replay', 'node_modules')),
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
    const { name, url, roles = [], appRegistration } = req.body;
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
      roles: roles.map(r => ({ role: r.role, username: r.username, hasMfa: !!r.mfaSeed })),
      hasAppRegistration: !!(appRegistration?.clientId),
    });
    writeEnvs(envs);
    res.json({ ok: true });
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
      .map(f => ({ name: f, relativePath: path.relative(projectDir, path.join(dir, f)).replace(/\\/g, '/') }));
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
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="report-${relDir.replace(/\//g, '-')}.pdf"`);
    doc.pipe(res);

    // Title
    doc.font('Helvetica-Bold').fontSize(20).text('4PS Test Automation Report', { align: 'center' });
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(12).fillColor('#666').text(data.workflow_name || relDir, { align: 'center' });
    doc.moveDown(1.5);

    // Summary box
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(14).text('Summary');
    doc.moveDown(0.3);
    const overall = data.overall || 'UNKNOWN';
    doc.font('Helvetica').fontSize(11);
    doc.text(`Result: ${overall}`, { continued: false });
    doc.text(`Start: ${data.start_time ? new Date(data.start_time).toLocaleString() : 'N/A'}`);
    doc.text(`End: ${data.end_time ? new Date(data.end_time).toLocaleString() : 'N/A'}`);
    doc.text(`Duration: ${data.duration_s ?? 'N/A'}s`);
    doc.text(`Total Steps: ${data.total_steps ?? 0}  |  Passed: ${data.passed ?? 0}  |  Failed: ${data.failed ?? 0}  |  Skipped: ${data.skipped ?? 0}`);
    doc.moveDown(1.5);

    // Steps table
    if (Array.isArray(data.steps) && data.steps.length) {
      doc.font('Helvetica-Bold').fontSize(14).text('Steps');
      doc.moveDown(0.4);

      // Table header
      const colX = [50, 130, 310, 395, 470];
      const y = doc.y;
      doc.rect(50, y, 500, 18).fill('#2a2a2a');
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9);
      doc.text('STEP ID', colX[0] + 4, y + 4, { width: 76 });
      doc.text('NAME', colX[1] + 4, y + 4, { width: 176 });
      doc.text('USER', colX[2] + 4, y + 4, { width: 80 });
      doc.text('STATUS', colX[3] + 4, y + 4, { width: 70 });
      doc.text('DURATION', colX[4] + 4, y + 4, { width: 70 });
      doc.y = y + 20;
      doc.fillColor('#000');

      for (const step of data.steps) {
        if (doc.y > 750) { doc.addPage(); doc.y = 50; }
        const sy = doc.y;
        const status = step.status || 'unknown';
        doc.font('Courier').fontSize(9).text(step.id || '', colX[0] + 4, sy + 3, { width: 76 });
        doc.font('Helvetica').fontSize(9).text(step.name || '', colX[1] + 4, sy + 3, { width: 176 });
        doc.text(step.user || '', colX[2] + 4, sy + 3, { width: 80 });
        // Status with color
        const statusColor = status === 'passed' ? '#1a7a3f' : status === 'failed' ? '#c0392b' : '#666';
        doc.fillColor(statusColor).text(status.toUpperCase(), colX[3] + 4, sy + 3, { width: 70 });
        doc.fillColor('#000').text(step.duration_s != null ? step.duration_s + 's' : '-', colX[4] + 4, sy + 3, { width: 70 });
        doc.y = sy + 18;

        // Draw line
        doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor('#e0e0e0').stroke();
        doc.y += 2;

        // Sub-results
        if (step.sub_results?.length) {
          for (const sub of step.sub_results) {
            if (doc.y > 750) { doc.addPage(); doc.y = 50; }
            const ssy = doc.y;
            const subStatus = sub.status || 'unknown';
            doc.font('Helvetica').fontSize(8).fillColor('#666');
            doc.text('  ' + (sub.label || sub.script || ''), colX[1] + 14, ssy + 2, { width: 160 });
            const sc = subStatus === 'passed' ? '#1a7a3f' : subStatus === 'failed' ? '#c0392b' : '#666';
            doc.fillColor(sc).text(subStatus.toUpperCase(), colX[3] + 4, ssy + 2, { width: 70 });
            doc.fillColor('#000').text(sub.duration_s != null ? sub.duration_s + 's' : '-', colX[4] + 4, ssy + 2, { width: 70 });
            doc.y = ssy + 14;
          }
        }
      }
    }

    // Footer
    doc.moveDown(2);
    doc.font('Helvetica').fontSize(8).fillColor('#999')
      .text(`Generated by 4PS Test Automation on ${new Date().toLocaleString()}`, 50, doc.y, { align: 'center', width: 500 });

    doc.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3333;
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log('  4PS Test Automation');
  console.log(`  Running at: ${url}`);
  console.log('');
  // Open in default browser (Windows)
  exec(`start ${url}`, { shell: true });
});

process.on('SIGINT', () => { wss.close(); server.close(); process.exit(0); });
