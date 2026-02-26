# TODO — Productize BC Page Scripting

> Goal: Turn this into a solution usable by customers and functional consultants with no PowerShell or terminal knowledge.  
> Architecture: Node.js + Express local web server. Browser UI is the front-end. All PowerShell scripts are kept as-is and called as child processes — so the pipeline path is unchanged.

---

## Delivery model

- User runs `start.bat` (or `start.ps1`) — Node.js server starts, browser opens automatically
- Day-to-day use: 100% in the browser, no terminal required
- Pipeline use: same PowerShell scripts called directly, credentials injected as pipeline secrets
- Credentials stored in **Windows Credential Manager** via `keytar` (never on disk as plain text)

---

## Tasks

### Phase 1 — App scaffold and launcher

- [ ] Create `app/` folder at workspace root
- [ ] Create `app/package.json` — dependencies: `express`, `keytar`, `ws`, `open`, `chokidar`
- [ ] Create `app/server.js` — Express server on port 3333, serves `app/public/`, mounts `/api/` routes
- [ ] Create `app/public/index.html` — SPA shell with left-nav sidebar tabs: Setup · Environments · Workflow Builder · Variants · Run · Results
- [ ] Create `start.bat` — checks for `app/node_modules`, runs `npm install --prefix app` if missing, then `node app/server.js`, then opens `http://localhost:3333`
- [ ] Create `start.ps1` — same logic as `start.bat` for PowerShell users
- [ ] Add `app/node_modules/` and `app/.setup-complete` to `.gitignore`
- [ ] Start a `chokidar` watcher on `page-scripting/` for `**/*.yml` and `**/workflow.json` changes — push a WebSocket event to connected clients so the relevant tab refreshes its file list automatically

---

### Phase 2 — Onboarding / setup wizard (Setup tab)

- [ ] Server checks on startup: Node.js version >= 18, `bc-replay/node_modules` exists
- [ ] Frontend: visual checklist with green ticks or red "Fix" buttons
- [ ] `/api/setup/install` endpoint — runs `npm install` in `bc-replay/`, streams stdout back via WebSocket
- [ ] Link to Node.js download page if version check fails
- [ ] Write `app/.setup-complete` flag after all checks pass to skip wizard on next launch

---

### Phase 3 — Credential and environment management (Environments tab)

- [ ] Frontend form: Environment name, BC URL (with format hint + validation), list of user roles each with username / password / optional MFA seed
- [ ] `/api/credentials` GET — list saved environments (names only, no passwords)
- [ ] `/api/credentials` POST — save credentials to Windows Credential Manager via `keytar` (service key: `bc-replay:<env>:<role>`)
- [ ] `/api/credentials` DELETE — remove a saved environment
- [ ] Before spawning any run, server reads credentials from keytar and injects them as environment variables into the child process — `users.json` on disk never contains real passwords
- [ ] Mark `bc-replay/setup-local-env.ps1.template` as superseded in its own header comment (developer reference only)

---

### Phase 4 — Workflow Builder integration (Workflow Builder tab)

- [ ] Extract the JS logic from `tools/workflow-builder/index.html` into `app/public/js/workflow-builder.js`
- [ ] Embed the workflow designer as a tab in the SPA (same functionality as today)
- [ ] Replace the "download JSON" button with **"Save to project folder"** — POSTs to `/api/projects/:name/workflow`, server writes `workflow.json` directly to the correct subfolder (no manual file move)
- [ ] Add **"Load existing"** button — GET `/api/projects/:name/workflow`, populates the designer
- [ ] Remove `users.sample.json` export — credential data now comes from the Environments tab
- [ ] Keep `tools/workflow-builder/index.html` as a standalone fallback (no changes to it)

---

### Phase 5 — Variant generator UI (Variants tab)

- [ ] Frontend form: BASE .yml file picker (browsing `page-scripting/` subfolders), Items textarea, Locations textarea, Vendors textarea, Output folder (auto-defaults to `<project>/Variants/`)
- [ ] `/api/variants/generate` POST — spawns `page-scripting/Generate-BC-Script-Variants.ps1` with the correct parameters, streams stdout back via WebSocket
- [ ] Display generated variant filenames on completion with file count and any warnings
- [ ] No rewrite of the PowerShell script — it remains the single source of truth

---

### Phase 6 — One-click Run with live output (Run tab)

- [ ] Frontend: dropdown to select project / workflow, **Run** button, real-time console output panel (WebSocket)
- [ ] `/api/run` POST — resolves credentials from keytar, injects as env vars, spawns `bc-replay/Run-BCWorkflow.ps1` (multi-user) or `npx replay` (single script) as a child process
- [ ] Stream stdout + stderr to the frontend via WebSocket in real time
- [ ] Status indicators: running (spinner) · passed (green) · failed (red with exit code)
- [ ] On completion: **"View Report"** button — calls `/api/report/open` which uses the `open` package to open the Playwright HTML report in a new browser tab

---

### Phase 7 — Results tab

- [ ] Read the most recent `bc-replay/test-results/` folder on page load
- [ ] Parse `results.xml` on the server and return pass/fail counts via `/api/results/summary`
- [ ] Embed or link the workflow summary HTML generated by `bc-replay/New-WorkflowReport.ps1`
- [ ] Show a history list of past runs with timestamps and pass/fail status

---

### Phase 8 — Documentation and distribution updates

- [ ] Update `README.md`: replace PowerShell-first quick start with "double-click `start.bat`, follow the setup wizard"
- [ ] Update `GETTING_STARTED.md`: condense to 3 steps — install Node.js → double-click start.bat → follow the wizard
- [ ] Add disclaimer footnote to `README.md`: "for demo and research purposes only, use at your own risk"
- [ ] Update `docs/OVERVIEW.md` screenshots to reflect the new UI
- [ ] Review and update `SECURITY.md` to reflect keytar credential storage

---

## Pipeline usage (unchanged)

The PowerShell scripts are called identically in a pipeline — no changes needed to them:

```yaml
# Azure DevOps example
- task: PowerShell@2
  inputs:
    filePath: bc-replay/Run-BCWorkflow.ps1
  env:
    BC_USERNAME: $(BC_USERNAME)
    BC_PASSWORD: $(BC_PASSWORD)
```

---

## Out of scope (future phases)

- Hosted version (Azure Static Web App + Azure Function backend)
- Electron packaging (true desktop app, no browser)
- In-app BC recording (requires BC browser extension integration)
- Pipeline definition generator (generate Azure DevOps / GitHub Actions YAML from a workflow)
