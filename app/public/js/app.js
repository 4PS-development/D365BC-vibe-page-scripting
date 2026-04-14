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

let activeTab = 'setup';

function activateTab(tabId) {
  // Auto-save workflow when leaving the workflow tab
  if (activeTab === 'workflow' && tabId !== 'workflow') {
    autoSaveWorkflow();
  }
  activeTab = tabId;

  document.querySelectorAll('.nav-item').forEach(i => i.classList.toggle('active', i.dataset.tab === tabId));
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === `tab-${tabId}`));

  // Lazy-load tab data
  if (tabId === 'setup')        loadSetup();
  if (tabId === 'environments') loadEnvironments();
  if (tabId === 'catalog')      loadCatalog();
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
      { label: 'bc-replay dependencies', ok: s.bcReplayInstalled, warn: !s.bcReplayInstalled, msg: s.bcReplayInstalled ? 'node_modules found' : 'Click “Install bc-replay dependencies” below' },
      { label: 'Playwright Chromium browser', ok: s.chromiumInstalled, warn: !s.chromiumInstalled, msg: s.chromiumInstalled ? 'Browser found in ms-playwright cache' : 'Click “Install Playwright Chromium” below' },
      { label: `Credentials backend: ${s.credBackend}`, ok: true, msg: '' },
    ];

    rows.forEach(r => {
      const d = document.createElement('div');
      d.className = 'check-item ' + (r.ok ? 'ok' : r.warn ? 'warn' : 'error');
      d.innerHTML = `<span class="check-icon"></span><span><strong>${r.label}</strong>${r.msg ? ' — ' + r.msg : ''}</span>`;
      container.appendChild(d);
    });

    const actionsEl  = document.getElementById('setup-actions');
    const btnReplay  = document.getElementById('btn-install-bcreplay');
    const btnPW      = document.getElementById('btn-install-playwright');
    const needAny    = !s.bcReplayInstalled || !s.chromiumInstalled;
    actionsEl.style.display = needAny ? '' : 'none';
    btnReplay.style.display = !s.bcReplayInstalled ? '' : 'none';
    btnPW.style.display     = !s.chromiumInstalled ? '' : 'none';
  } catch (e) {
    container.innerHTML = `<div class="check-item error"><span class="check-icon"></span>Could not reach server: ${e.message}</div>`;
  }
}

document.getElementById('btn-install-bcreplay').addEventListener('click', async () => {
  document.getElementById('setup-output').textContent = '';
  document.getElementById('setup-output-card').style.display = '';
  await POST('/setup/install');
});

document.getElementById('btn-install-playwright').addEventListener('click', async () => {
  document.getElementById('setup-output').textContent = '';
  document.getElementById('setup-output-card').style.display = '';
  await POST('/setup/install-playwright');
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
    if (env.isDefault) card.classList.add('env-default');
    const chips = (env.roles || []).map(r =>
      `<span class="role-chip has-cred">${r.role}: ${r.username || '—'}</span>`
    ).join('');
    const appRegBadge = env.hasAppRegistration
      ? '<span class="role-chip has-cred" style="border-color:var(--primary);color:var(--primary)">App Reg</span>'
      : '';
    const companiesBadge = (env.companies && env.companies.length)
      ? `<span class="role-chip has-cred" style="border-color:#0369a1;color:#0369a1">${env.companies.length} compan${env.companies.length === 1 ? 'y' : 'ies'}</span>`
      : '';
    const defaultBadge = env.isDefault
      ? '<span class="env-default-badge">DEFAULT</span>'
      : '';
    const defaultBtn = env.isDefault
      ? ''
      : `<button class="btn btn-secondary btn-sm" data-setdefault="${esc(env.name)}" title="Use as default environment">Set Default</button>`;
    card.innerHTML = `
      <div class="env-card-header">
        <span class="env-card-name">${esc(env.name)}${defaultBadge}</span>
        <div class="env-card-actions">
          ${defaultBtn}
          <button class="btn btn-secondary btn-sm" data-export="${esc(env.name)}" title="Export credentials to a project folder">Export</button>
          <button class="btn btn-secondary btn-sm" data-edit="${esc(env.name)}">Edit</button>
          <button class="btn btn-danger btn-sm" data-del="${esc(env.name)}">Delete</button>
        </div>
      </div>
      <div class="env-card-url">${esc(env.url)}</div>
      <div class="env-card-roles">${chips}${companiesBadge}${appRegBadge}</div>`;
    card.querySelector('[data-del]').addEventListener('click', () => deleteEnv(env.name));
    card.querySelector('[data-edit]').addEventListener('click', () => openEnvModal(env.name));
    card.querySelector('[data-export]').addEventListener('click', () => openExportCredsModal(env.name));
    const setDefBtn = card.querySelector('[data-setdefault]');
    if (setDefBtn) setDefBtn.addEventListener('click', () => setDefaultEnv(env.name));
    grid.appendChild(card);
  });
}

async function deleteEnv(name) {
  if (!confirm(`Delete environment "${name}"? All stored credentials will be removed.`)) return;
  await DEL(`/environments/${encodeURIComponent(name)}`);
  await loadEnvironments();
}

async function setDefaultEnv(name) {
  await api('PATCH', `/environments/${encodeURIComponent(name)}/default`);
  await loadEnvironments();
}

function getDefaultEnvName() {
  const def = state.environments.find(e => e.isDefault);
  return def ? def.name : null;
}

// Add / Edit environment modal
let modalRoleCount = 0;
let editingEnvName = null; // null = create mode, string = edit mode
let modalCompanies = [];   // companies list for the current environment being edited

document.getElementById('btn-new-env').addEventListener('click', () => openEnvModal());
document.getElementById('btn-seed-env').addEventListener('click', () => openSeedModal());
document.getElementById('btn-cancel-env').addEventListener('click', closeEnvModal);
document.querySelector('#modal-env .modal-backdrop').addEventListener('click', closeEnvModal);
document.getElementById('btn-add-role').addEventListener('click', addRoleRow);
document.getElementById('btn-save-env').addEventListener('click', saveEnv);

// Companies management
document.getElementById('btn-add-company').addEventListener('click', addCompanyFromInput);
document.getElementById('env-company-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); addCompanyFromInput(); }
});

function addCompanyFromInput() {
  const input = document.getElementById('env-company-input');
  const name = input.value.trim();
  if (!name) return;
  if (modalCompanies.includes(name)) { input.value = ''; return; }
  modalCompanies.push(name);
  input.value = '';
  renderCompanies();
}

function removeCompany(index) {
  modalCompanies.splice(index, 1);
  renderCompanies();
}

function renderCompanies() {
  const list = document.getElementById('env-companies-list');
  if (!modalCompanies.length) {
    list.innerHTML = '<p style="font-size:12px;color:var(--text-muted);margin:4px 0">No companies added yet.</p>';
    return;
  }
  list.innerHTML = modalCompanies.map((c, i) =>
    `<div style="display:flex;align-items:center;gap:8px;padding:5px 8px;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:4px;background:var(--surface)">
      <span style="flex:1;font-size:13px">${esc(c)}</span>
      <button class="btn btn-secondary btn-sm" onclick="removeCompany(${i})" style="padding:2px 8px;font-size:11px;color:var(--danger)">&times;</button>
    </div>`
  ).join('');
}

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
  modalCompanies = [];
  document.getElementById('env-name').value = '';
  document.getElementById('env-url').value = '';
  document.getElementById('env-roles-list').innerHTML = '';
  document.getElementById('env-appreg-clientid').value = '';
  document.getElementById('env-appreg-secret').value = '';
  document.getElementById('env-appreg-tenantid').value = '';
  document.getElementById('env-appreg-company').innerHTML = '<option value="">-- fetch companies first --</option>';
  renderCompanies();

  if (existingName) {
    document.getElementById('modal-env-title').textContent = 'Edit Environment';
    document.getElementById('env-name').value = existingName;
    document.getElementById('env-name').readOnly = true;

    // Load existing data from server
    try {
      const env = await GET(`/environments/${encodeURIComponent(existingName)}`);
      document.getElementById('env-url').value = env.url || '';

      // Pre-fill companies
      modalCompanies = env.companies || [];
      renderCompanies();

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

// ── Export credentials to project ─────────────────────────────────────────────
async function openExportCredsModal(envName) {
  document.getElementById('export-env-name').textContent = envName;
  const projects = await GET('/projects').catch(() => []);
  const sel = document.getElementById('export-project');
  sel.innerHTML = '';
  if (!projects.length) {
    sel.innerHTML = '<option value="">No projects found</option>';
  } else {
    projects.forEach(p => sel.appendChild(new Option(p.name, p.name)));
  }
  document.getElementById('modal-export-creds').classList.remove('hidden');
}

document.getElementById('btn-cancel-export-creds').addEventListener('click', () => {
  document.getElementById('modal-export-creds').classList.add('hidden');
});
document.querySelector('#modal-export-creds .modal-backdrop').addEventListener('click', () => {
  document.getElementById('modal-export-creds').classList.add('hidden');
});

document.getElementById('btn-confirm-export-creds').addEventListener('click', async () => {
  const envName = document.getElementById('export-env-name').textContent;
  const project = document.getElementById('export-project').value;
  if (!project) { alert('Select a project.'); return; }

  const btn = document.getElementById('btn-confirm-export-creds');
  btn.disabled = true; btn.textContent = 'Exporting\u2026';

  try {
    const r = await POST(`/environments/${encodeURIComponent(envName)}/export`, { project });
    if (r.ok) {
      alert(`Credentials exported to ${r.path}\n\nRoles: ${r.roles.join(', ')}\n\nYour colleague can now open the app and click \"Seed from project files\" to import them.`);
    }
  } catch (e) {
    alert('Export failed: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Export';
    document.getElementById('modal-export-creds').classList.add('hidden');
  }
});

function openMfaHelp() {
  document.getElementById('modal-mfa-help').classList.remove('hidden');
}

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
        <span style="display:flex;align-items:flex-start;gap:4px;font-size:11px;color:#888;line-height:1.4;margin-top:4px">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="flex-shrink:0;margin-top:1px"><rect x="3" y="7" width="10" height="8" rx="1"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>
          Stored in <strong style="color:#666">Windows Credential Manager</strong> (or DPAPI-encrypted file if keytar is unavailable) — never written to disk in plain text.
        </span>
      </label>
      <label>
        <span style="display:flex;align-items:center;gap:6px">
          MFA seed <small>(optional)</small>
          <button type="button" class="btn-mfa-help" onclick="openMfaHelp()" title="How to get your TOTP seed">?</button>
        </span>
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
    await POST('/environments', { name, url, roles, appRegistration, companies: modalCompanies });
    closeEnvModal();
    await loadEnvironments();
  } catch (e) {
    alert(`Failed to save: ${e.message}`);
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
}

// ── Workflow Designer ─────────────────────────────────────────────────────────

// Auto-save: request the iframe to export, then silently save on receipt
let autoSaving = false;
function autoSaveWorkflow() {
  const iframe = document.getElementById('wf-iframe');
  if (!iframe?.contentWindow) return;
  autoSaving = true;
  iframe.contentWindow.postMessage({ type: 'request-export', project: '__autosave__', silent: true }, '*');
}

// Receive export data from the workflow builder iframe
window.addEventListener('message', async evt => {
  if (evt.data?.type === 'export-error') {
    // Silently ignore validation errors during auto-save
    if (autoSaving) { autoSaving = false; return; }
  }
  if (evt.data?.type === 'export-workflow') {
    const { project, workflow } = evt.data;
    if (!workflow) return;
    // Determine the real project name from the workflow or the message
    const name = (project && project !== '__autosave__') ? project : (workflow.name || '').trim();
    if (!name) return;
    const silent = autoSaving;
    autoSaving = false;
    try {
      await POST(`/projects/${encodeURIComponent(name)}/workflow`, workflow);
      if (!silent) alert(`Saved to page-scripting/${name}/workflow.json`);
    } catch (e) {
      if (!silent) alert(`Save failed: ${e.message}`);
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
  const [cat, projects, envs] = await Promise.all([
    GET('/catalog').catch(() => null),
    GET('/projects').catch(() => []),
    GET('/environments').catch(() => []),
  ]);
  state.projects = projects;
  state.environments = envs;

  // Environment dropdown with default pre-selected
  const eSel = document.getElementById('run-environment');
  const curE = eSel.value;
  eSel.innerHTML = '<option value="">— select environment —</option>';
  envs.forEach(e => eSel.appendChild(new Option(e.name + (e.isDefault ? ' (default)' : ''), e.name)));
  const defaultEnv = envs.find(e => e.isDefault);
  if (curE && envs.find(e => e.name === curE)) eSel.value = curE;
  else if (defaultEnv) eSel.value = defaultEnv.name;

  // Build catalog tree with checkboxes
  const tree = document.getElementById('run-catalog-tree');
  const projectSet = new Set(projects.filter(p => p.hasWorkflow).map(p => p.name));

  if (!cat || !cat.value_chains || !cat.value_chains.length) {
    tree.innerHTML = '<p class="text-muted" style="padding:8px">No catalog loaded. Configure the catalog first.</p>';
    updateRunSelectedCount();
    return;
  }

  let html = '';
  for (const vc of cat.value_chains) {
    const vcId = `run-vc-${vc.code}`;
    html += `<div class="run-tree-vc">
      <label class="run-tree-label run-tree-vc-label">
        <input type="checkbox" class="run-vc-cb" data-vc="${esc(vc.code)}" id="${vcId}">
        <strong>${esc(vc.code)}</strong> <span>${esc(vc.name)}</span>
      </label>`;
    for (const type of (vc.types || [])) {
      const typeId = `run-type-${vc.code}-${type.code}`;
      html += `<div class="run-tree-type">
        <label class="run-tree-label">
          <input type="checkbox" class="run-type-cb" data-vc="${esc(vc.code)}" data-type="${esc(type.code)}" id="${typeId}">
          <strong>${esc(type.code)}</strong> <span>${esc(type.name)}</span>
        </label>`;
      for (const pf of (type.process_flows || [])) {
        const projName = (pf.workflow_path || '').replace(/^\.\//, '');
        const available = projectSet.has(projName);
        const pfId = `run-pf-${vc.code}-${type.code}-${pf.code}`;
        html += `<div class="run-tree-pf">
          <label class="run-tree-label${!available ? ' run-tree-disabled' : ''}">
            <input type="checkbox" class="run-pf-cb" data-vc="${esc(vc.code)}" data-type="${esc(type.code)}" data-project="${esc(projName)}" id="${pfId}" ${!available ? 'disabled' : ''}>
            <code>${esc(pf.code)}</code> <span>${esc(pf.name)}</span>
            ${!available ? '<span class="text-muted" style="font-size:11px">(no workflow)</span>' : ''}
          </label>
        </div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  }
  tree.innerHTML = html;

  // Wire up parent-child checkbox cascading
  tree.querySelectorAll('.run-vc-cb').forEach(cb => cb.addEventListener('change', () => {
    const vc = cb.dataset.vc;
    tree.querySelectorAll(`.run-type-cb[data-vc="${vc}"], .run-pf-cb[data-vc="${vc}"]`).forEach(c => { if (!c.disabled) c.checked = cb.checked; });
    updateRunSelectedCount();
  }));
  tree.querySelectorAll('.run-type-cb').forEach(cb => cb.addEventListener('change', () => {
    const vc = cb.dataset.vc, type = cb.dataset.type;
    tree.querySelectorAll(`.run-pf-cb[data-vc="${vc}"][data-type="${type}"]`).forEach(c => { if (!c.disabled) c.checked = cb.checked; });
    syncParentCheckbox(tree, vc);
    updateRunSelectedCount();
  }));
  tree.querySelectorAll('.run-pf-cb').forEach(cb => cb.addEventListener('change', () => {
    const vc = cb.dataset.vc, type = cb.dataset.type;
    syncTypeCheckbox(tree, vc, type);
    syncParentCheckbox(tree, vc);
    updateRunSelectedCount();
  }));

  updateRunSelectedCount();
}

function syncTypeCheckbox(tree, vc, type) {
  const pfs = tree.querySelectorAll(`.run-pf-cb[data-vc="${vc}"][data-type="${type}"]:not(:disabled)`);
  const checked = tree.querySelectorAll(`.run-pf-cb[data-vc="${vc}"][data-type="${type}"]:checked`);
  const typeCb = tree.querySelector(`.run-type-cb[data-vc="${vc}"][data-type="${type}"]`);
  if (typeCb) {
    typeCb.checked = pfs.length > 0 && checked.length === pfs.length;
    typeCb.indeterminate = checked.length > 0 && checked.length < pfs.length;
  }
}

function syncParentCheckbox(tree, vc) {
  const types = tree.querySelectorAll(`.run-type-cb[data-vc="${vc}"]`);
  const checked = [...types].filter(c => c.checked);
  const indet = [...types].filter(c => c.indeterminate);
  const vcCb = tree.querySelector(`.run-vc-cb[data-vc="${vc}"]`);
  if (vcCb) {
    vcCb.checked = types.length > 0 && checked.length === types.length && indet.length === 0;
    vcCb.indeterminate = (checked.length > 0 || indet.length > 0) && (checked.length < types.length || indet.length > 0);
  }
}

function getSelectedRunProjects() {
  return [...document.querySelectorAll('.run-pf-cb:checked')].map(cb => cb.dataset.project);
}

function updateRunSelectedCount() {
  const count = getSelectedRunProjects().length;
  const el = document.getElementById('run-selected-count');
  if (el) el.textContent = count ? `${count} process flow${count > 1 ? 's' : ''} selected` : 'No process flows selected';
}

document.getElementById('btn-run-select-all').addEventListener('click', () => {
  document.querySelectorAll('.run-pf-cb:not(:disabled), .run-type-cb, .run-vc-cb').forEach(cb => cb.checked = true);
  document.querySelectorAll('.run-type-cb, .run-vc-cb').forEach(cb => cb.indeterminate = false);
  updateRunSelectedCount();
});
document.getElementById('btn-run-select-none').addEventListener('click', () => {
  document.querySelectorAll('.run-pf-cb, .run-type-cb, .run-vc-cb').forEach(cb => { cb.checked = false; cb.indeterminate = false; });
  updateRunSelectedCount();
});

document.getElementById('btn-run').addEventListener('click', async () => {
  const selectedProjects = getSelectedRunProjects();
  const environment = document.getElementById('run-environment').value;
  if (!selectedProjects.length) { alert('Select at least one process flow.'); return; }

  document.getElementById('run-output').textContent = '';
  document.getElementById('run-output-card').style.display = '';

  const btn = document.getElementById('btn-run');
  btn.disabled = true; btn.textContent = 'Running…';
  try {
    await POST('/run', {
      projects: selectedProjects,
      environment,
      headed:        document.getElementById('run-headed').checked,
      stopOnFailure: document.getElementById('run-stop-on-failure').checked,
      dryRun:        document.getElementById('run-dry-run').checked,
    });
  } catch (e) {
    appendOutput('run-output', `Error: ${e.message}\n`);
    btn.disabled = false; btn.textContent = 'Run Selected';
  }
});

function onRunDone(msg) {
  const btn = document.getElementById('btn-run');
  btn.disabled = false; btn.textContent = 'Run Selected';

  const line = msg.code === 0 ? '\n--- Run complete. ---\n' : `\n--- Run failed (exit ${msg.code})${msg.error ? ': ' + msg.error : ''} ---\n`;
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
// ── Catalog ──────────────────────────────────────────────────────────────────
let catalog = null;
let catEditNode = null; // { level:'vc'|'type'|'pf', v, t?, p? }

async function loadCatalog() {
  if (catalog) { renderCatalog(); return; }
  try {
    catalog = await GET('/catalog');
  } catch {
    catalog = { name: '', description: '', value_chains: [] };
  }
  document.getElementById('cat-name').value = catalog.name || '';
  document.getElementById('cat-desc').value = catalog.description || '';
  renderCatalog();
}

function syncCatalogMeta() {
  if (!catalog) return;
  catalog.name = document.getElementById('cat-name').value.trim();
  catalog.description = document.getElementById('cat-desc').value.trim();
}

function renderCatalog() {
  const container = document.getElementById('cat-tree-container');
  if (!catalog || !catalog.value_chains) { container.innerHTML = '<p class="text-muted" style="text-align:center;padding:24px">No value chains yet. Click "+ Add Value Chain" to start.</p>'; return; }

  let html = '';
  for (let v = 0; v < catalog.value_chains.length; v++) {
    const vc = catalog.value_chains[v];
    const vcEditing = catEditNode && catEditNode.level === 'vc' && catEditNode.v === v;
    html += `<div class="card cat-vc-card">`;
    html += `<div class="cat-vc-header">
      <code>${esc(vc.code || '?')}</code>
      <strong>${esc(vc.name || '(unnamed)')}</strong>
      ${vc.description ? '<span class="text-muted" style="font-size:12px;margin-left:8px">' + esc(vc.description) + '</span>' : ''}
      <div class="cat-actions">
        <button class="btn btn-secondary btn-sm" onclick="catEditVc(${v})">Edit</button>
        <button class="btn btn-secondary btn-sm" onclick="catRemoveVc(${v})" style="color:var(--error)">Remove</button>
      </div>
    </div>`;

    if (vcEditing) {
      html += `<div class="cat-edit-form">
        <input class="input input-sm" id="cat-ed-vc-code" value="${esc(vc.code || '')}" placeholder="Code (e.g. PRJ)" maxlength="10" style="width:100px;text-transform:uppercase" title="Short uppercase code (max 10 chars). Used as composite code prefix, e.g. PRJ.">
        <input class="input input-sm" id="cat-ed-vc-name" value="${esc(vc.name || '')}" placeholder="Name" style="flex:1" title="Display name for this value chain, e.g. Projecten.">
        <input class="input input-sm" id="cat-ed-vc-desc" value="${esc(vc.description || '')}" placeholder="Description" style="flex:1" title="Optional description of this value chain.">
        <button class="btn btn-primary btn-sm" onclick="catSaveVc(${v})">Done</button>
      </div>`;
    }

    // Types within this VC
    for (let t = 0; t < (vc.types || []).length; t++) {
      const type = vc.types[t];
      const typeEditing = catEditNode && catEditNode.level === 'type' && catEditNode.v === v && catEditNode.t === t;

      html += `<div class="cat-type-block">
        <div class="cat-type-header">
          <code>${esc(vc.code)}-${esc(type.code || '?')}</code>
          <strong>${esc(type.name || '(unnamed)')}</strong>
          ${type.description ? '<span class="text-muted" style="font-size:12px;margin-left:6px">' + esc(type.description) + '</span>' : ''}
          <div class="cat-actions">
            <button class="btn btn-secondary btn-sm" onclick="catEditType(${v},${t})">Edit</button>
            <button class="btn btn-secondary btn-sm" onclick="catRemoveType(${v},${t})" style="color:var(--error)">Remove</button>
          </div>
        </div>`;

      if (typeEditing) {
        html += `<div class="cat-edit-form">
          <input class="input input-sm" id="cat-ed-type-code" value="${esc(type.code || '')}" placeholder="Code" maxlength="10" style="width:100px;text-transform:uppercase" title="Short uppercase code (max 10 chars). Combined with parent, e.g. PRJ-TM.">
          <input class="input input-sm" id="cat-ed-type-name" value="${esc(type.name || '')}" placeholder="Name" style="flex:1" title="Display name for this type, e.g. Termijnmotivering.">
          <input class="input input-sm" id="cat-ed-type-desc" value="${esc(type.description || '')}" placeholder="Description" style="flex:1" title="Optional description of this project type.">
          <button class="btn btn-primary btn-sm" onclick="catSaveType(${v},${t})">Done</button>
        </div>`;
      }

      // Process flows within this type
      for (let p = 0; p < (type.process_flows || []).length; p++) {
        const pf = type.process_flows[p];
        const pfEditing = catEditNode && catEditNode.level === 'pf' && catEditNode.v === v && catEditNode.t === t && catEditNode.p === p;

        html += `<div class="cat-pf-row">
          <code>${esc(vc.code)}-${esc(type.code)}-${esc(pf.code || '?')}</code>
          <span>${esc(pf.name || '(unnamed)')}</span>
          <div class="cat-actions">
            ${pf.name ? `<button class="btn btn-primary btn-sm" onclick="catOpenPfWorkflow(${v},${t},${p})">Open</button>` : ''}
            <button class="btn btn-secondary btn-sm" onclick="catEditPf(${v},${t},${p})">Edit</button>
            <button class="btn btn-secondary btn-sm" onclick="catRemovePf(${v},${t},${p})" style="color:var(--error)">Remove</button>
          </div>
        </div>`;

        if (pfEditing) {
          html += `<div class="cat-edit-form">
            <input class="input input-sm" id="cat-ed-pf-code" value="${esc(pf.code || '')}" placeholder="Code" maxlength="10" style="width:100px;text-transform:uppercase" title="Short uppercase code (max 10 chars). Full composite: PRJ-TM-PO-APPR.">
            <input class="input input-sm" id="cat-ed-pf-name" value="${esc(pf.name || '')}" placeholder="Name" style="flex:1" title="Display name for this process flow, e.g. PO Approval.">
            <input class="input input-sm" id="cat-ed-pf-desc" value="${esc(pf.description || '')}" placeholder="Description" style="flex:1" title="Optional description of what this process flow tests.">
            <button class="btn btn-primary btn-sm" onclick="catSavePf(${v},${t},${p})">Done</button>
            <button class="btn btn-primary btn-sm" onclick="catSavePfAndOpen(${v},${t},${p})">Save & Open</button>
          </div>`;
        }
      }
      html += `<div class="cat-add-row">
        <span class="cat-add-link" style="padding:0" onclick="catAddPf(${v},${t})">+ New Process Flow</span>
        <span class="cat-link-existing" onclick="catLinkExisting(${v},${t})">&#128279; Link Existing Workflow</span>
      </div>`;
      html += `<div id="cat-existing-picker-${v}-${t}" class="cat-existing-picker" style="display:none">
        <strong>Select a project folder with a workflow.json:</strong>
        <select id="cat-existing-select-${v}-${t}" onchange="catApplyExisting(${v},${t},this.value)">
          <option value="">-- loading... --</option>
        </select>
        <div class="picker-hint">Only projects with workflow.json are shown. Already-cataloged ones are marked.</div>
        <div class="picker-actions">
          <button class="btn btn-secondary btn-sm" onclick="document.getElementById('cat-existing-picker-${v}-${t}').style.display='none'">Cancel</button>
        </div>
      </div>`;
      html += `</div>`; // type-block
    }
    html += `<div class="cat-add-link" onclick="catAddType(${v})">+ Type</div>`;
    html += `</div>`; // vc-card
  }
  container.innerHTML = html;
}

// CRUD
function catEditVc(v) { syncCatalogMeta(); catEditNode = { level: 'vc', v }; renderCatalog(); }
function catSaveVc(v) {
  syncCatalogMeta();
  const vc = catalog.value_chains[v];
  vc.code = (document.getElementById('cat-ed-vc-code').value || '').toUpperCase().trim();
  vc.name = document.getElementById('cat-ed-vc-name').value.trim();
  vc.description = document.getElementById('cat-ed-vc-desc').value.trim();
  if (!vc.code) { alert('Code is required'); return; }
  catEditNode = null; renderCatalog();
}
function catRemoveVc(v) {
  if (!confirm(`Remove value chain "${catalog.value_chains[v].code || '(unnamed)'}" and all its contents?`)) return;
  syncCatalogMeta(); catalog.value_chains.splice(v, 1); catEditNode = null; renderCatalog();
}
function catAddVc() {
  syncCatalogMeta();
  if (!catalog) catalog = { name: '', description: '', value_chains: [] };
  if (!catalog.value_chains) catalog.value_chains = [];
  catalog.value_chains.push({ code: '', name: '', description: '', types: [] });
  catEditNode = { level: 'vc', v: catalog.value_chains.length - 1 }; renderCatalog();
}

function catEditType(v, t) { syncCatalogMeta(); catEditNode = { level: 'type', v, t }; renderCatalog(); }
function catSaveType(v, t) {
  syncCatalogMeta();
  const type = catalog.value_chains[v].types[t];
  type.code = (document.getElementById('cat-ed-type-code').value || '').toUpperCase().trim();
  type.name = document.getElementById('cat-ed-type-name').value.trim();
  type.description = document.getElementById('cat-ed-type-desc').value.trim();
  if (!type.code) { alert('Code is required'); return; }
  catEditNode = null; renderCatalog();
}
function catRemoveType(v, t) {
  if (!confirm(`Remove type "${catalog.value_chains[v].types[t].code || '(unnamed)'}" and all its process flows?`)) return;
  syncCatalogMeta(); catalog.value_chains[v].types.splice(t, 1); catEditNode = null; renderCatalog();
}
function catAddType(v) {
  syncCatalogMeta();
  if (!catalog.value_chains[v].types) catalog.value_chains[v].types = [];
  catalog.value_chains[v].types.push({ code: '', name: '', description: '', process_flows: [] });
  catEditNode = { level: 'type', v, t: catalog.value_chains[v].types.length - 1 }; renderCatalog();
}

function catEditPf(v, t, p) { syncCatalogMeta(); catEditNode = { level: 'pf', v, t, p }; renderCatalog(); }
function catSavePf(v, t, p) {
  syncCatalogMeta();
  const pf = catalog.value_chains[v].types[t].process_flows[p];
  pf.code = (document.getElementById('cat-ed-pf-code').value || '').toUpperCase().trim();
  pf.name = document.getElementById('cat-ed-pf-name').value.trim();
  pf.description = document.getElementById('cat-ed-pf-desc').value.trim();
  if (!pf.code) { alert('Code is required'); return; }
  pf.workflow_path = pf.name ? './' + pf.name : '';
  catEditNode = null; renderCatalog();
}
async function catSavePfAndOpen(v, t, p) {
  syncCatalogMeta();
  const pf = catalog.value_chains[v].types[t].process_flows[p];
  pf.code = (document.getElementById('cat-ed-pf-code').value || '').toUpperCase().trim();
  pf.name = document.getElementById('cat-ed-pf-name').value.trim();
  pf.description = document.getElementById('cat-ed-pf-desc').value.trim();
  if (!pf.code) { alert('Code is required'); return; }
  if (!pf.name) { alert('Name is required'); return; }
  pf.workflow_path = './' + pf.name;
  catEditNode = null; renderCatalog();
  // Save catalog first
  try { await POST('/catalog', catalog); } catch (e) { alert('Save failed: ' + e.message); return; }
  // Open the workflow in the builder
  catOpenPfWorkflow(v, t, p);
}
function catRemovePf(v, t, p) {
  if (!confirm(`Remove process flow "${catalog.value_chains[v].types[t].process_flows[p].code || '(unnamed)'}"?`)) return;
  syncCatalogMeta(); catalog.value_chains[v].types[t].process_flows.splice(p, 1); catEditNode = null; renderCatalog();
}
function catAddPf(v, t) {
  syncCatalogMeta();
  if (!catalog.value_chains[v].types[t].process_flows) catalog.value_chains[v].types[t].process_flows = [];
  catalog.value_chains[v].types[t].process_flows.push({ code: '', name: '', description: '', workflow_path: '' });
  catEditNode = { level: 'pf', v, t, p: catalog.value_chains[v].types[t].process_flows.length - 1 }; renderCatalog();
}

/** Show the existing-workflow picker, fetching projects from the server */
async function catLinkExisting(v, t) {
  syncCatalogMeta();
  const pickerId = `cat-existing-picker-${v}-${t}`;
  const selectId = `cat-existing-select-${v}-${t}`;
  const pickerEl = document.getElementById(pickerId);
  const selectEl = document.getElementById(selectId);
  if (!pickerEl || !selectEl) return;
  pickerEl.style.display = 'block';

  // Collect already-cataloged workflow paths
  const cataloged = new Set();
  if (catalog && catalog.value_chains) {
    for (const vc of catalog.value_chains)
      for (const tp of (vc.types || []))
        for (const pf of (tp.process_flows || []))
          if (pf.workflow_path) cataloged.add(pf.workflow_path.replace(/^\.\//,''));
  }

  try {
    const projects = await GET('/projects');
    const withWf = projects.filter(p => p.hasWorkflow);
    if (!withWf.length) {
      selectEl.innerHTML = '<option value="">-- no projects with workflow.json --</option>';
      return;
    }
    selectEl.innerHTML = '<option value="">-- select project --</option>' +
      withWf.map(p => {
        const inCat = cataloged.has(p.name);
        return `<option value="${esc(p.name)}">${esc(p.name)}${inCat ? ' (already in catalog)' : ''}</option>`;
      }).join('');
  } catch (e) {
    selectEl.innerHTML = '<option value="">-- server not reachable --</option>';
  }
}

/** When a project is picked, fetch its workflow.json and add a pre-filled process flow */
async function catApplyExisting(v, t, projectName) {
  if (!projectName) return;
  syncCatalogMeta();

  let wfName = projectName, wfDesc = '';
  try {
    const wf = await GET(`/projects/${encodeURIComponent(projectName)}/workflow`);
    if (wf.name) wfName = wf.name;
    if (wf.description) wfDesc = wf.description;
  } catch { /* use folder name */ }

  const autoCode = projectName.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 10);

  if (!catalog.value_chains[v].types[t].process_flows)
    catalog.value_chains[v].types[t].process_flows = [];
  catalog.value_chains[v].types[t].process_flows.push({
    code: autoCode, name: wfName, description: wfDesc, workflow_path: './' + projectName
  });
  const idx = catalog.value_chains[v].types[t].process_flows.length - 1;
  catEditNode = { level: 'pf', v, t, p: idx };
  renderCatalog();
}

// Open an existing process flow workflow in the Workflow Designer
async function catOpenPfWorkflow(v, t, p) {
  const pf = catalog.value_chains[v].types[t].process_flows[p];
  if (!pf.workflow_path) { alert('No workflow path set for this process flow.'); return; }
  const projectName = pf.workflow_path.replace(/^\.\//, '');
  // Ensure environments are loaded so we can find the default
  if (!state.environments.length) {
    state.environments = await GET('/environments').catch(() => []);
  }
  const defaultEnv = getDefaultEnvName();

  // Switch to workflow tab first so the iframe is loaded
  activateTab('workflow');
  // Wait a tick for the iframe to be ready
  await new Promise(r => setTimeout(r, 200));

  // Load the workflow into the iframe
  try {
    const wf = await GET(`/projects/${encodeURIComponent(projectName)}/workflow`);
    document.getElementById('wf-iframe').contentWindow.postMessage({
      type: 'load-workflow', workflow: wf, project: projectName, environment: defaultEnv
    }, '*');
  } catch {
    // No workflow.json yet — just activate the project in the iframe
    document.getElementById('wf-iframe').contentWindow.postMessage({
      type: 'load-workflow', workflow: null, project: projectName, environment: defaultEnv
    }, '*');
  }
}

// Save / Import / Export
document.getElementById('btn-cat-save').addEventListener('click', async () => {
  syncCatalogMeta();
  try {
    await POST('/catalog', catalog);
    alert('Catalog saved to server.');
  } catch (e) {
    alert('Save failed: ' + e.message);
  }
});

document.getElementById('btn-cat-export').addEventListener('click', () => {
  syncCatalogMeta();
  const blob = new Blob([JSON.stringify(catalog, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'catalog.json'; a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById('btn-cat-import').addEventListener('click', () => {
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
  input.onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data.value_chains) { alert('Invalid catalog — missing value_chains'); return; }
      catalog = data;
      document.getElementById('cat-name').value = catalog.name || '';
      document.getElementById('cat-desc').value = catalog.description || '';
      catEditNode = null; renderCatalog();
    } catch (err) { alert('Error: ' + err.message); }
  };
  input.click();
});

document.getElementById('btn-cat-add-vc').addEventListener('click', catAddVc);

// ── Utils ─────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Render a ? tooltip icon. Usage: `${tip('Your help text')}` */
function tip(text) {
  return `<span class="field-tip" tabindex="0">?<span class="field-tip-text">${esc(text)}</span></span>`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
activateTab('setup');
