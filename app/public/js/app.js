/* global WebSocket */
'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  environments: [],
  projects: [],
};

// ── API helpers ───────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}
const GET    = (p)    => api('GET',    p);
const POST   = (p, b) => api('POST',   p, b);
const DEL    = (p)    => api('DELETE', p);

// ── Tab routing ───────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => activateTab(item.dataset.tab));
});

function activateTab(tabId) {
  document.querySelectorAll('.nav-item').forEach(i => i.classList.toggle('active', i.dataset.tab === tabId));
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === `tab-${tabId}`));

  // Lazy-load tab data
  if (tabId === 'setup')        loadSetup();
  if (tabId === 'environments') loadEnvironments();
  if (tabId === 'workflow')     loadWorkflowProjects();
  if (tabId === 'variants')     loadVariantProjects();
  if (tabId === 'run')          loadRunPage();
  if (tabId === 'evaluate')     loadEvaluatePage();
  if (tabId === 'results')      loadResults();
  // Tips tab is static — no data to load
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
let ws;
function connectWs() {
  ws = new WebSocket(`ws://${location.host}`);
  const dot = document.getElementById('ws-status');

  ws.onopen  = () => { dot.className = 'status-dot connected'; };
  ws.onclose = () => { dot.className = 'status-dot disconnected'; setTimeout(connectWs, 3000); };

  ws.onmessage = evt => {
    const msg = JSON.parse(evt.data);

    if (msg.type === 'setup-output') appendOutput('setup-output', msg.data);
    if (msg.type === 'setup-done')   onSetupDone(msg.code);

    if (msg.type === 'variant-output') appendOutput('var-output', msg.data);
    if (msg.type === 'variant-done')   onVariantDone(msg);

    if (msg.type === 'run-output') appendOutput('run-output', msg.data);
    if (msg.type === 'run-done')   onRunDone(msg);

    if (msg.type === 'evaluate-done')   onEvaluateDone(msg);

    if (msg.type === 'files-changed') onFilesChanged(msg);
  };
}
connectWs();

function appendOutput(elId, text) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.closest('.card').style.display = '';
  // Basic colorize
  const line = document.createElement('span');
  const lower = text.toLowerCase();
  if (lower.includes('error') || lower.includes('fail'))  line.className = 'line-error';
  else if (lower.includes('warn'))                         line.className = 'line-warn';
  else if (lower.includes('success') || lower.includes('done') || lower.includes('complet')) line.className = 'line-ok';
  line.textContent = text;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function onFilesChanged(msg) {
  // Re-fetch project lists if a yml or workflow.json changed
  if (/\.(ya?ml)$/i.test(msg.path) || /workflow\.json$/i.test(msg.path)) {
    loadVariantProjects();
    loadRunPage();
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────
async function loadSetup() {
  const container = document.getElementById('setup-checks');
  container.innerHTML = '<div class="check-item loading"><span class="check-icon"></span>Checking…</div>';
  try {
    const s = await GET('/setup/status');
    container.innerHTML = '';

    const rows = [
      { label: `Node.js ${s.nodeVersion}`, ok: s.nodeOk, warn: !s.nodeOk, msg: s.nodeOk ? 'Node.js 18+ detected' : 'Node.js 18 or later is required' },
      { label: s.psVersion, ok: s.psOk, warn: !s.psOk, msg: s.psOk ? 'PowerShell 7 detected' : 'PowerShell 7 is required — install from aka.ms/powershell' },
      { label: 'bc-replay dependencies', ok: s.bcReplayInstalled, warn: !s.bcReplayInstalled, msg: s.bcReplayInstalled ? 'node_modules found' : 'Run install below' },
      { label: `Credentials backend: ${s.credBackend}`, ok: true, msg: '' },
    ];

    rows.forEach(r => {
      const d = document.createElement('div');
      d.className = 'check-item ' + (r.ok ? 'ok' : r.warn ? 'warn' : 'error');
      d.innerHTML = `<span class="check-icon"></span><span><strong>${r.label}</strong>${r.msg ? ' — ' + r.msg : ''}</span>`;
      container.appendChild(d);
    });

    const actionsEl = document.getElementById('setup-actions');
    if (!s.bcReplayInstalled) actionsEl.style.display = '';
    else actionsEl.style.display = 'none';
  } catch (e) {
    container.innerHTML = `<div class="check-item error"><span class="check-icon"></span>Could not reach server: ${e.message}</div>`;
  }
}

document.getElementById('btn-install-bcreplay').addEventListener('click', async () => {
  document.getElementById('setup-output').textContent = '';
  document.getElementById('setup-output-card').style.display = '';
  await POST('/setup/install');
});

function onSetupDone(code) {
  appendOutput('setup-output', code === 0 ? '\n✅ Installation complete.\n' : `\n❌ Installation failed (exit ${code}).\n`);
  loadSetup();
}

// ── Environments ──────────────────────────────────────────────────────────────
async function loadEnvironments() {
  const data = await GET('/environments').catch(() => []);
  state.environments = data;
  renderEnvList();
}

function renderEnvList() {
  const grid = document.getElementById('env-list');
  grid.innerHTML = '';
  if (!state.environments.length) {
    grid.innerHTML = '<p style="color:var(--text-muted)">No environments yet. Click "+ Add Environment" to get started.</p>';
    return;
  }
  state.environments.forEach(env => {
    const card = document.createElement('div');
    card.className = 'env-card';
    const chips = (env.roles || []).map(r =>
      `<span class="role-chip has-cred">${r.role}: ${r.username || '—'}</span>`
    ).join('');
    const appRegBadge = env.hasAppRegistration
      ? '<span class="role-chip has-cred" style="border-color:var(--primary);color:var(--primary)">App Reg</span>'
      : '';
    card.innerHTML = `
      <div class="env-card-header">
        <span class="env-card-name">${esc(env.name)}</span>
        <div class="env-card-actions">
          <button class="btn btn-secondary btn-sm" data-edit="${esc(env.name)}">Edit</button>
          <button class="btn btn-danger btn-sm" data-del="${esc(env.name)}">Delete</button>
        </div>
      </div>
      <div class="env-card-url">${esc(env.url)}</div>
      <div class="env-card-roles">${chips}${appRegBadge}</div>`;
    card.querySelector('[data-del]').addEventListener('click', () => deleteEnv(env.name));
    card.querySelector('[data-edit]').addEventListener('click', () => openEnvModal(env.name));
    grid.appendChild(card);
  });
}

async function deleteEnv(name) {
  if (!confirm(`Delete environment "${name}"? All stored credentials will be removed.`)) return;
  await DEL(`/environments/${encodeURIComponent(name)}`);
  await loadEnvironments();
}

// Add / Edit environment modal
let modalRoleCount = 0;
let editingEnvName = null; // null = create mode, string = edit mode

document.getElementById('btn-new-env').addEventListener('click', () => openEnvModal());
document.getElementById('btn-seed-env').addEventListener('click', () => openSeedModal());
document.getElementById('btn-cancel-env').addEventListener('click', closeEnvModal);
document.querySelector('#modal-env .modal-backdrop').addEventListener('click', closeEnvModal);
document.getElementById('btn-add-role').addEventListener('click', addRoleRow);
document.getElementById('btn-save-env').addEventListener('click', saveEnv);

// Auto-extract tenant ID from BC URL
document.getElementById('env-url').addEventListener('input', function () {
  const m = this.value.match(/bc\.dynamics\.com\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (m) {
    document.getElementById('env-appreg-tenantid').value = m[1];
  }
});

// Fetch companies from BC API
document.getElementById('btn-fetch-companies').addEventListener('click', async () => {
  const clientId     = document.getElementById('env-appreg-clientid').value.trim();
  const clientSecret = document.getElementById('env-appreg-secret').value.trim();
  const tenantId     = document.getElementById('env-appreg-tenantid').value.trim();
  const bcUrl        = document.getElementById('env-url').value.trim();

  if (!clientId || !clientSecret || !tenantId) {
    alert('Client ID, Client Secret, and Tenant ID are required to fetch companies.');
    return;
  }

  const btn = document.getElementById('btn-fetch-companies');
  btn.disabled = true; btn.textContent = '...';
  try {
    const data = await POST('/bc/companies', { clientId, clientSecret, tenantId, bcUrl });
    const sel = document.getElementById('env-appreg-company');
    sel.innerHTML = '<option value="">-- select company --</option>';
    (data.companies || []).forEach(c => {
      const opt = new Option(`${c.displayName || c.name}`, c.id);
      opt.dataset.companyName = c.displayName || c.name;
      sel.appendChild(opt);
    });
    // Auto-select if only one company
    if (data.companies?.length === 1) sel.value = data.companies[0].id;
  } catch (e) {
    alert('Failed to fetch companies: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Fetch';
  }
});

async function openEnvModal(existingName) {
  modalRoleCount = 0;
  editingEnvName = existingName || null;
  document.getElementById('env-name').value = '';
  document.getElementById('env-url').value = '';
  document.getElementById('env-roles-list').innerHTML = '';
  document.getElementById('env-appreg-clientid').value = '';
  document.getElementById('env-appreg-secret').value = '';
  document.getElementById('env-appreg-tenantid').value = '';
  document.getElementById('env-appreg-company').innerHTML = '<option value="">-- fetch companies first --</option>';

  if (existingName) {
    document.getElementById('modal-env-title').textContent = 'Edit Environment';
    document.getElementById('env-name').value = existingName;
    document.getElementById('env-name').readOnly = true;

    // Load existing data from server
    try {
      const env = await GET(`/environments/${encodeURIComponent(existingName)}`);
      document.getElementById('env-url').value = env.url || '';

      // Pre-fill roles
      for (const r of (env.roles || [])) {
        addRoleRow(r.role, r.username, r.hasPassword, r.hasMfa);
      }

      // Pre-fill app registration
      if (env.appRegistration) {
        document.getElementById('env-appreg-clientid').value = env.appRegistration.clientId || '';
        document.getElementById('env-appreg-tenantid').value = env.appRegistration.tenantId || '';
        if (env.appRegistration.hasSecret) {
          document.getElementById('env-appreg-secret').placeholder = '(unchanged — enter new value to update)';
        }
        if (env.appRegistration.companyId) {
          const sel = document.getElementById('env-appreg-company');
          sel.innerHTML = `<option value="${esc(env.appRegistration.companyId)}">${esc(env.appRegistration.companyName || env.appRegistration.companyId)}</option>`;
          sel.value = env.appRegistration.companyId;
        }
      }

      // Auto-extract tenant from URL
      const m = (env.url || '').match(/bc\.dynamics\.com\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (m && !document.getElementById('env-appreg-tenantid').value) {
        document.getElementById('env-appreg-tenantid').value = m[1];
      }
    } catch (e) {
      // Could not load — just open empty modal
    }

    if (!document.querySelectorAll('.role-row').length) addRoleRow();
  } else {
    document.getElementById('modal-env-title').textContent = 'Add Environment';
    document.getElementById('env-name').readOnly = false;
    document.getElementById('env-appreg-secret').placeholder = '••••••••';
    addRoleRow();
  }

  document.getElementById('modal-env').classList.remove('hidden');
  if (!existingName) document.getElementById('env-name').focus();
  else document.getElementById('env-url').focus();
}
function closeEnvModal() { document.getElementById('modal-env').classList.add('hidden'); }

// ── Seed environment from project files ───────────────────────────────────────
async function openSeedModal() {
  // Find projects that have a users.json
  const projects = await GET('/projects').catch(() => []);
  const seedable = [];
  for (const p of projects) {
    const info = await GET(`/projects/${encodeURIComponent(p.name)}/seed-info`).catch(() => null);
    if (info) seedable.push({ project: p.name, info });
  }
  if (!seedable.length) {
    alert('No projects found with both workflow.json and users.json.');
    return;
  }

  // Build preview HTML
  const rows = seedable.map(({ project, info }) => {
    const roleList = info.roles.map(r =>
      `<span class="role-chip has-cred">${esc(r.role)}: ${esc(r.username)}</span>`
    ).join(' ');
    return `
      <div class="seed-row" data-project="${esc(project)}">
        <div class="seed-row-header">
          <label class="checkbox-label">
            <input type="checkbox" class="seed-check" value="${esc(project)}" checked />
            <strong>${esc(project)}</strong>
          </label>
        </div>
        <div class="seed-url" style="font-size:11px;color:var(--text-muted);margin:4px 0 6px 23px;word-break:break-all">${esc(info.bc_url)}</div>
        <div style="margin-left:23px;display:flex;flex-wrap:wrap;gap:6px">${roleList}</div>
      </div>`;
  }).join('<hr style="margin:12px 0;border:none;border-top:1px solid var(--border)">');

  // Inject modal content
  document.getElementById('modal-seed-body').innerHTML = rows;
  document.getElementById('modal-seed').classList.remove('hidden');
}

document.getElementById('btn-cancel-seed').addEventListener('click', () => {
  document.getElementById('modal-seed').classList.add('hidden');
});
document.querySelector('#modal-seed .modal-backdrop').addEventListener('click', () => {
  document.getElementById('modal-seed').classList.add('hidden');
});

document.getElementById('btn-confirm-seed').addEventListener('click', async () => {
  const checked = [...document.querySelectorAll('.seed-check:checked')].map(el => el.value);
  if (!checked.length) { alert('Select at least one project.'); return; }

  const btn = document.getElementById('btn-confirm-seed');
  btn.disabled = true; btn.textContent = 'Seeding…';

  const errors = [];
  for (const project of checked) {
    try {
      const r = await POST(`/projects/${encodeURIComponent(project)}/seed`);
      if (!r.ok) errors.push(`${project}: ${r.error}`);
    } catch (e) {
      errors.push(`${project}: ${e.message}`);
    }
  }

  btn.disabled = false; btn.textContent = 'Seed';
  document.getElementById('modal-seed').classList.add('hidden');

  if (errors.length) alert('Some projects failed:\n' + errors.join('\n'));
  await loadEnvironments();
});

function addRoleRow(roleName, username, hasPassword, hasMfa) {
  const id = ++modalRoleCount;
  const row = document.createElement('div');
  row.className = 'role-row';
  row.dataset.roleId = id;
  row.innerHTML = `
    <div class="role-row-header">
      <strong>Role ${id}</strong>
      <button class="btn btn-secondary btn-sm" data-rm="${id}">Remove</button>
    </div>
    <div class="role-row-grid">
      <label>Role name
        <input type="text" class="input" data-field="role" placeholder="Purchaser" value="${esc(roleName || '')}" />
      </label>
      <label>Username (email)
        <input type="email" class="input" data-field="username" placeholder="user@contoso.com" value="${esc(username || '')}" />
      </label>
      <label>Password
        <input type="password" class="input" data-field="password" placeholder="${hasPassword ? '(unchanged — enter new value to update)' : '••••••••'}" autocomplete="new-password" />
      </label>
      <label>MFA seed <small>(optional)</small>
        <input type="password" class="input" data-field="mfaSeed" placeholder="${hasMfa ? '(unchanged)' : 'TOTP secret'}" autocomplete="off" />
      </label>
    </div>`;
  row.querySelector('[data-rm]').addEventListener('click', () => row.remove());
  document.getElementById('env-roles-list').appendChild(row);
}

async function saveEnv() {
  const name = document.getElementById('env-name').value.trim();
  const url  = document.getElementById('env-url').value.trim();
  if (!name || !url) { alert('Name and URL are required.'); return; }

  const roles = [];
  document.querySelectorAll('.role-row').forEach(row => {
    const g = f => row.querySelector(`[data-field="${f}"]`)?.value.trim() || '';
    roles.push({ role: g('role'), username: g('username'), password: g('password'), mfaSeed: g('mfaSeed') });
  });

  // Gather app registration data
  const companySel = document.getElementById('env-appreg-company');
  const selectedOpt = companySel.selectedOptions[0];
  const appRegistration = {
    clientId:     document.getElementById('env-appreg-clientid').value.trim(),
    clientSecret: document.getElementById('env-appreg-secret').value.trim(),
    tenantId:     document.getElementById('env-appreg-tenantid').value.trim(),
    companyId:    companySel.value || '',
    companyName:  selectedOpt?.dataset.companyName || selectedOpt?.textContent?.trim() || '',
  };

  const btn = document.getElementById('btn-save-env');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await POST('/environments', { name, url, roles, appRegistration });
    closeEnvModal();
    await loadEnvironments();
  } catch (e) {
    alert(`Failed to save: ${e.message}`);
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
}

// ── Workflow Designer ─────────────────────────────────────────────────────────
async function loadWorkflowProjects() {
  const data = await GET('/projects').catch(() => []);
  state.projects = data;
  const sel = document.getElementById('wf-project-select');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— select project —</option>';
  data.forEach(p => {
    const opt = new Option(p.name + (p.hasWorkflow ? ' ✓' : ''), p.name);
    sel.appendChild(opt);
  });
  if (cur && data.find(p => p.name === cur)) sel.value = cur;
}

document.getElementById('btn-wf-load').addEventListener('click', async () => {
  const name = document.getElementById('wf-project-select').value;
  if (!name) return;
  try {
    const wf = await GET(`/projects/${encodeURIComponent(name)}/workflow`);
    document.getElementById('wf-iframe').contentWindow.postMessage({ type: 'load-workflow', workflow: wf }, '*');
  } catch { /* workflow.json might not exist yet — that's fine */ }
});

document.getElementById('btn-wf-save').addEventListener('click', () => {
  const name = document.getElementById('wf-project-select').value;
  if (!name) { alert('Select a project first.'); return; }
  document.getElementById('wf-iframe').contentWindow.postMessage({ type: 'request-export', project: name }, '*');
});

// Receive export data from the workflow builder iframe
window.addEventListener('message', async evt => {
  if (evt.data?.type === 'export-workflow') {
    const { project, workflow } = evt.data;
    if (!project || !workflow) return;
    try {
      await POST(`/projects/${encodeURIComponent(project)}/workflow`, workflow);
      alert(`Saved to page-scripting/${project}/workflow.json`);
      loadWorkflowProjects();
    } catch (e) {
      alert(`Save failed: ${e.message}`);
    }
  }
});

// ── Variant Generator ─────────────────────────────────────────────────────────
async function loadVariantProjects() {
  const data = await GET('/projects').catch(() => []);
  state.projects = data;
  const sel = document.getElementById('var-project');
  sel.innerHTML = '<option value="">— select project —</option>';
  data.forEach(p => sel.appendChild(new Option(p.name, p.name)));
}

document.getElementById('var-project').addEventListener('change', async function () {
  const name = this.value;
  const scriptSel = document.getElementById('var-base-script');
  scriptSel.innerHTML = '<option value="">— select base script —</option>';
  if (!name) return;
  const scripts = await GET(`/projects/${encodeURIComponent(name)}/scripts`).catch(() => []);
  scripts.forEach(s => scriptSel.appendChild(new Option(s.name, s.relativePath || s.name)));
});

document.getElementById('btn-generate').addEventListener('click', async () => {
  const project    = document.getElementById('var-project').value;
  const baseScript = document.getElementById('var-base-script').value;
  const items      = document.getElementById('var-items').value.trim();
  const locations  = document.getElementById('var-locations').value.trim();

  if (!project || !baseScript) { alert('Select a project and base script.'); return; }

  document.getElementById('var-output').textContent = '';
  document.getElementById('var-output-card').style.display = '';

  const btn = document.getElementById('btn-generate');
  btn.disabled = true; btn.textContent = 'Generating…';
  try {
    await POST('/variants/generate', { project, baseScript, items, locations });
  } catch (e) {
    appendOutput('var-output', `Error: ${e.message}\n`);
  } finally {
    btn.disabled = false; btn.textContent = 'Generate Variants';
  }
});

function onVariantDone(msg) {
  const line = msg.code === 0
    ? `\n✅ Done — variants in ${msg.outputFolder}\n`
    : `\n❌ Failed (exit ${msg.code})${msg.error ? ': ' + msg.error : ''}\n`;
  appendOutput('var-output', line);
  if (msg.code === 0) loadVariantProjects();
}

// ── Run ───────────────────────────────────────────────────────────────────────
async function loadRunPage() {
  const [projects, envs] = await Promise.all([
    GET('/projects').catch(() => []),
    GET('/environments').catch(() => []),
  ]);
  state.projects = projects;
  state.environments = envs;

  const pSel = document.getElementById('run-project');
  const eSel = document.getElementById('run-environment');
  const curP = pSel.value, curE = eSel.value;

  pSel.innerHTML = '<option value="">— select project —</option>';
  projects.filter(p => p.hasWorkflow).forEach(p => pSel.appendChild(new Option(p.name, p.name)));
  if (curP && projects.find(p => p.name === curP)) pSel.value = curP;

  eSel.innerHTML = '<option value="">— select environment —</option>';
  envs.forEach(e => eSel.appendChild(new Option(e.name, e.name)));
  if (curE && envs.find(e => e.name === curE)) eSel.value = curE;
}

document.getElementById('btn-run').addEventListener('click', async () => {
  const project     = document.getElementById('run-project').value;
  const environment = document.getElementById('run-environment').value;
  if (!project) { alert('Select a project.'); return; }

  document.getElementById('run-output').textContent = '';
  document.getElementById('run-output-card').style.display = '';

  const btn = document.getElementById('btn-run');
  btn.disabled = true; btn.textContent = 'Running…';
  try {
    await POST('/run', {
      project,
      environment,
      headed:        document.getElementById('run-headed').checked,
      stopOnFailure: document.getElementById('run-stop-on-failure').checked,
      dryRun:        document.getElementById('run-dry-run').checked,
    });
  } catch (e) {
    appendOutput('run-output', `Error: ${e.message}\n`);
    btn.disabled = false; btn.textContent = 'Run';
  }
});

function onRunDone(msg) {
  const btn = document.getElementById('btn-run');
  btn.disabled = false; btn.textContent = 'Run';

  const line = msg.code === 0 ? '\n✅ Run complete.\n' : `\n❌ Run failed (exit ${msg.code})${msg.error ? ': ' + msg.error : ''}\n`;
  appendOutput('run-output', line);
  // After a run completes, auto-refresh results so the new run appears immediately
  if (document.getElementById('tab-results').classList.contains('active')) loadResults();
}

// ── Results ───────────────────────────────────────────────────────────────────
let activeRunId = null;

async function loadResults() {
  const data  = await GET('/results').catch(() => []);
  const list  = document.getElementById('results-run-list');
  const empty = document.getElementById('results-empty');
  list.innerHTML = '';

  if (!data.length) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  data.forEach(r => {
    const card = document.createElement('div');
    card.className = `run-card status-${r.overall}${r.id === activeRunId ? ' active' : ''}`;
    card.dataset.runId = r.id;

    const dt   = r.start_time ? new Date(r.start_time).toLocaleString() : '—';
    const dur  = r.duration_s != null ? `${r.duration_s}s` : '';
    card.innerHTML = `
      <div class="run-card-name">${esc(r.workflow_name)}</div>
      <div class="run-card-meta">${esc(dt)}${dur ? ' &bull; ' + esc(dur) : ''}</div>
      <div class="run-card-badges">
        <span class="run-badge ${r.overall}">${esc(r.overall)}</span>
        ${r.passed  ? `<span style="font-size:11px;color:var(--success)">✓ ${r.passed}</span>` : ''}
        ${r.failed  ? `<span style="font-size:11px;color:var(--error)">✗ ${r.failed}</span>` : ''}
        ${r.skipped ? `<span style="font-size:11px;color:var(--warning)">- ${r.skipped}</span>` : ''}
      </div>`;

    card.addEventListener('click', () => showRunDetail(r.id, card));
    list.appendChild(card);
  });

  // Auto-open the first (most recent) run
  if (data.length && !activeRunId) {
    list.firstChild.click();
  }
}

async function showRunDetail(runId, cardEl) {
  activeRunId = runId;
  document.querySelectorAll('.run-card').forEach(c => c.classList.toggle('active', c.dataset.runId === runId));

  const placeholder = document.getElementById('results-detail-placeholder');
  const content     = document.getElementById('results-detail-content');
  placeholder.style.display = 'none';
  content.style.display = '';
  content.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">Loading…</div>';

  let data;
  try {
    data = await GET(`/results/detail?id=${encodeURIComponent(runId)}`);
  } catch (e) {
    content.innerHTML = `<div class="empty-state"><p>Could not load report: ${esc(e.message)}</p></div>`;
    return;
  }

  const start    = data.start_time ? new Date(data.start_time) : null;
  const end      = data.end_time   ? new Date(data.end_time)   : null;
  const overall  = data.overall || 'UNKNOWN';
  const durText  = data.duration_s != null ? `${data.duration_s}s` : '';

  // Build steps table rows
  let stepsRows = '';
  let stepIdx = 0;
  for (const step of (data.steps || [])) {
    const status    = step.status || 'unknown';
    const reportBtn = step.reportUrl
      ? `<a href="${esc(step.reportUrl)}" target="_blank" class="step-report-link">Open Playwright report</a>`
      : `<span style="color:var(--text-muted);font-size:12px">No report</span>`;
    const screenshotCount = step.screenshots?.length || 0;
    const screenshotBtn   = screenshotCount
      ? `<button class="btn btn-secondary btn-sm" style="margin-left:6px" onclick="showStepScreenshots(${JSON.stringify(JSON.stringify(step.screenshots))})">&#128247; ${screenshotCount}</button>`
      : '';

    const hasReportDir = !!step.report_dir;
    const expandBtn = hasReportDir
      ? `<button class="btn btn-secondary btn-sm step-expand-btn" data-step-idx="${stepIdx}" data-report-dir="${esc(step.report_dir)}">&#9660; Details</button>`
      : '';

    const hasSubResults = step.sub_results?.length > 0;
    stepsRows += `
      <tr class="step-main-row" data-step-idx="${stepIdx}">
        <td style="white-space:nowrap;font-family:monospace;font-size:12px">${esc(step.id)}</td>
        <td><strong>${esc(step.name)}</strong></td>
        <td style="font-size:12px">${esc(step.user || '')}</td>
        <td><span class="step-badge ${esc(status)}">${esc(status)}</span></td>
        <td style="white-space:nowrap;font-size:12px">${step.duration_s != null ? step.duration_s + 's' : '—'}</td>
        <td style="white-space:nowrap">${expandBtn} ${reportBtn}${screenshotBtn}</td>
      </tr>
      <tr class="step-detail-row hidden" id="step-detail-${stepIdx}">
        <td colspan="6" class="step-detail-cell">
          <div class="step-detail-loading">Loading step details...</div>
        </td>
      </tr>`;

    if (hasSubResults) {
      for (const sub of step.sub_results) {
        const subStatus = sub.status || 'unknown';
        stepsRows += `
          <tr class="sub-row">
            <td></td>
            <td>${esc(sub.label || sub.script || '')}</td>
            <td></td>
            <td><span class="step-badge ${esc(subStatus)}" style="font-size:10px">${esc(subStatus)}</span></td>
            <td style="font-size:12px">${sub.duration_s != null ? sub.duration_s + 's' : '—'}</td>
            <td></td>
          </tr>`;
      }
    }
    stepIdx++;
  }

  content.innerHTML = `
    <div class="rd-header">
      <div class="rd-title-row">
        <span class="rd-badge ${esc(overall)}">${esc(overall)}</span>
        <h2>${esc(data.workflow_name || runId)}</h2>
        <a href="/api/results/pdf?id=${encodeURIComponent(runId)}" class="btn btn-secondary btn-sm" style="margin-left:auto" download>Download PDF</a>
      </div>
      <div class="rd-meta">
        ${start ? `<span>Started: ${start.toLocaleString()}</span>` : ''}
        ${end   ? `<span>Finished: ${end.toLocaleString()}</span>` : ''}
        ${durText ? `<span>Duration: ${esc(durText)}</span>` : ''}
      </div>
    </div>

    <div class="rd-summary-cards">
      <div class="rd-card"><div class="rc-label">Steps</div><div class="rc-value total">${data.total_steps ?? 0}</div></div>
      <div class="rd-card"><div class="rc-label">Passed</div><div class="rc-value passed">${data.passed ?? 0}</div></div>
      <div class="rd-card"><div class="rc-label">Failed</div><div class="rc-value failed">${data.failed ?? 0}</div></div>
      <div class="rd-card"><div class="rc-label">Skipped</div><div class="rc-value skipped">${data.skipped ?? 0}</div></div>
    </div>

    <div id="rd-steps">
      <table class="steps-table">
        <thead><tr>
          <th>Step ID</th><th>Name</th><th>User</th><th>Status</th><th>Duration</th><th>Actions</th>
        </tr></thead>
        <tbody>${stepsRows || '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No steps</td></tr>'}</tbody>
      </table>
    </div>`;

  // Wire up expand buttons
  content.querySelectorAll('.step-expand-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleStepDetail(btn));
  });
}

// Step detail expand/collapse
const stepDetailCache = {};
async function toggleStepDetail(btn) {
  const idx = btn.dataset.stepIdx;
  const detailRow = document.getElementById(`step-detail-${idx}`);
  if (!detailRow) return;

  const isHidden = detailRow.classList.contains('hidden');
  if (!isHidden) {
    detailRow.classList.add('hidden');
    btn.innerHTML = '&#9660; Details';
    return;
  }

  detailRow.classList.remove('hidden');
  btn.innerHTML = '&#9650; Details';

  const reportDir = btn.dataset.reportDir;
  const cacheKey = reportDir;

  if (stepDetailCache[cacheKey]) {
    renderStepDetail(detailRow, stepDetailCache[cacheKey]);
    return;
  }

  // Fetch from server
  try {
    const data = await GET(`/results/step-data?dir=${encodeURIComponent(reportDir)}`);
    stepDetailCache[cacheKey] = data;
    renderStepDetail(detailRow, data);
  } catch (e) {
    detailRow.querySelector('.step-detail-cell').innerHTML =
      `<div style="padding:12px;color:var(--error);font-size:12px">Could not load details: ${esc(e.message)}</div>`;
  }
}

function renderStepDetail(detailRow, data) {
  if (!data.steps?.length) {
    detailRow.querySelector('.step-detail-cell').innerHTML =
      '<div style="padding:12px;color:var(--text-muted);font-size:12px">No detailed action data available.</div>';
    return;
  }

  let html = '<div class="step-actions-list">';
  html += `<div class="step-actions-header">${esc(data.name || 'Test')} &mdash; ${data.totalSteps} actions</div>`;
  html += '<table class="step-actions-table">';
  html += '<thead><tr><th>#</th><th>Type</th><th>Description</th><th>Duration</th></tr></thead><tbody>';

  for (const s of data.steps) {
    const durText = s.duration_ms != null ? `${s.duration_ms}ms` : '';
    const typeClass = s.type === 'input' ? 'type-input' : s.type === 'invoke' ? 'type-invoke' : s.type === 'navigate' ? 'type-navigate' : '';
    html += `<tr>
      <td style="font-size:11px;color:var(--text-muted)">${s.index}</td>
      <td><span class="action-type ${typeClass}">${esc(s.type)}</span></td>
      <td style="font-size:12px">${esc(s.description)}${s.value ? ` = <strong>${esc(s.value)}</strong>` : ''}</td>
      <td style="font-size:11px;white-space:nowrap;color:var(--text-muted)">${durText}</td>
    </tr>`;
  }

  html += '</tbody></table></div>';
  detailRow.querySelector('.step-detail-cell').innerHTML = html;
}

function showStepScreenshots(jsonStr) {
  const urls = JSON.parse(jsonStr);
  const grid = document.getElementById('rd-screenshots-grid');
  grid.innerHTML = '';
  urls.forEach(url => {
    const img = document.createElement('img');
    img.src = url;
    img.className = 'screenshot-thumb';
    img.title = 'Click to enlarge';
    img.addEventListener('click', () => openLightbox(url));
    grid.appendChild(img);
  });
  document.getElementById('rd-screenshots').style.display = '';
  document.getElementById('rd-screenshots').scrollIntoView({ behavior: 'smooth' });
}

// ── Lightbox ──────────────────────────────────────────────────────────────────
function openLightbox(url) {
  document.getElementById('lightbox-img').src = url;
  document.getElementById('lightbox').classList.remove('hidden');
}
function closeLightbox() {
  document.getElementById('lightbox').classList.add('hidden');
  document.getElementById('lightbox-img').src = '';
}
document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
document.querySelector('.lightbox-backdrop').addEventListener('click', closeLightbox);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });

document.getElementById('btn-refresh-results').addEventListener('click', () => {
  activeRunId = null;
  document.getElementById('results-detail-content').style.display = 'none';
  document.getElementById('results-detail-placeholder').style.display = '';
  loadResults();
});

document.getElementById('btn-reset-results').addEventListener('click', async () => {
  if (!confirm('Delete ALL test results? This cannot be undone.')) return;
  try {
    await DEL('/results');
    activeRunId = null;
    document.getElementById('results-detail-content').style.display = 'none';
    document.getElementById('results-detail-placeholder').style.display = '';
    loadResults();
  } catch (e) {
    alert('Failed to reset results: ' + e.message);
  }
});
// ── Evaluate ─────────────────────────────────────────────────────────────────────
async function loadEvaluatePage() {
  const projects = await GET('/projects').catch(() => []);
  const sel = document.getElementById('eval-project');
  const cur = sel.value;
  sel.innerHTML = '<option value="">\u2014 select project \u2014</option>';
  projects.filter(p => p.hasWorkflow).forEach(p => sel.appendChild(new Option(p.name, p.name)));
  if (cur && projects.find(p => p.name === cur)) sel.value = cur;
}

document.getElementById('btn-evaluate').addEventListener('click', async () => {
  const project = document.getElementById('eval-project').value;
  if (!project) { alert('Select a project.'); return; }

  document.getElementById('eval-summary-card').style.display = 'none';
  document.getElementById('eval-report-frame').style.display = 'none';
  document.getElementById('btn-eval-open-report').style.display = 'none';

  const btn = document.getElementById('btn-evaluate');
  btn.disabled = true; btn.textContent = 'Evaluating\u2026';
  try {
    await POST('/evaluate', { project });
  } catch (e) {
    alert(`Evaluation failed: ${e.message}`);
    btn.disabled = false; btn.textContent = 'Evaluate';
  }
});

function onEvaluateDone(msg) {
  const btn = document.getElementById('btn-evaluate');
  btn.disabled = false; btn.textContent = 'Evaluate';

  if (msg.code !== 0) return;

  const report = msg.report;
  if (!report) return;

  const card = document.getElementById('eval-summary-card');
  card.style.display = '';

  const gradeColors = { A: '#1a7a3f', B: '#2e7d32', C: '#f57c00', D: '#e65100', F: '#c0392b' };
  const gc = gradeColors[report.grade] || '#666';
  document.getElementById('eval-grade').innerHTML = `<span style="background:${gc}">${esc(report.grade)}</span>`;
  document.getElementById('eval-summary-title').textContent = `Quality Score: ${report.overall_score}/100`;
  document.getElementById('eval-summary-meta').textContent =
    `${report.counts.errors} errors \u2022 ${report.counts.warnings} warnings \u2022 ${report.counts.info} suggestions`;

  const scores = report.scores;
  const scoreLabels = {
    validation_ratio: 'Validation Coverage',
    script_coverage: 'Script Coverage',
    capture_usage: 'Capture Usage',
    chain_integrity: 'Chain Integrity',
  };
  let scoresHtml = '';
  for (const [key, label] of Object.entries(scoreLabels)) {
    const val = scores[key] ?? 0;
    const color = val >= 75 ? 'var(--success)' : val >= 40 ? 'var(--warning)' : 'var(--error)';
    scoresHtml += `
      <div class="eval-score-item">
        <div class="eval-score-label">${esc(label)}</div>
        <div class="eval-score-bar"><div class="eval-score-fill" style="width:${val}%;background:${color}"></div></div>
        <div class="eval-score-val" style="color:${color}">${val}%</div>
      </div>`;
  }
  document.getElementById('eval-scores').innerHTML = scoresHtml;

  if (msg.htmlUrl) {
    const frame = document.getElementById('eval-report-frame');
    frame.style.display = '';
    document.getElementById('eval-iframe').src = msg.htmlUrl;

    const openBtn = document.getElementById('btn-eval-open-report');
    openBtn.style.display = '';
    openBtn.onclick = () => window.open(msg.htmlUrl, '_blank');
  }
}
// ── Utils ─────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
activateTab('setup');
