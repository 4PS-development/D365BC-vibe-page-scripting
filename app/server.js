'use strict';

const express   = require('express');
const http      = require('http');
const { WebSocketServer, OPEN } = require('ws');
const chokidar  = require('chokidar');
const path      = require('path');
const fs        = require('fs');
const { spawn, exec } = require('child_process');

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

app.post('/api/environments', async (req, res) => {
  try {
    const { name, url, roles = [] } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'name and url are required' });

    for (const r of roles) {
      if (r.password)  await saveCred(`${name}:${r.role}:password`, r.password);
      if (r.username)  await saveCred(`${name}:${r.role}:username`, r.username);
      if (r.mfaSeed)   await saveCred(`${name}:${r.role}:mfa`,      r.mfaSeed);
    }

    const envs = readEnvs().filter(e => e.name !== name);
    envs.push({
      name,
      url,
      roles: roles.map(r => ({ role: r.role, username: r.username, hasMfa: !!r.mfaSeed })),
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
    }
    writeEnvs(readEnvs().filter(e => e.name !== name));
    res.json({ ok: true });
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
// START
// ══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3333;
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log('  BC Page Scripting App');
  console.log(`  Running at: ${url}`);
  console.log('');
  // Open in default browser (Windows)
  exec(`start ${url}`, { shell: true });
});

process.on('SIGINT', () => { wss.close(); server.close(); process.exit(0); });
