# Getting Started with BC Page Scripting

Automate Business Central testing in four steps.

## What You Need

- A Business Central Sandbox environment
- A BC test account with page scripting permissions
- PowerShell 7+, Git, Node.js 16.14+ (checked automatically by `setup.ps1` below)

## Step 1 — Run Setup

From the repo root, run:

```powershell
.\setup.ps1
```

This checks your environment, installs dependencies, and opens the **Workflow Builder** in your browser.

> If you prefer to check requirements manually, see [bc-replay/BC_REPLAY_QUICK_START.md](bc-replay/BC_REPLAY_QUICK_START.md).

## Step 2 — Design Your Workflow (Workflow Builder)

Open [tools/workflow-builder/index.html](tools/workflow-builder/index.html) in any browser (no server needed).

1. Enter a **Workflow Name** and your **BC Environment URL**
2. Add **User Roles** (e.g. `purchaser`, `approver`)
3. Drop your recorded `.yml` scripts into the Script Library
4. Add steps, assign roles, and wire captures/injects
5. Click **Export** — follow the post-export instructions in the popup

> For single-user variant batch testing (no workflow needed), skip to Step 4.

## Step 3 — Configure Credentials

After exporting from the Workflow Builder:

1. Copy `users.sample.json` to `users.json` in your workflow folder
2. Fill in real values for each role:
   - `username` — BC account email
   - `password` — BC account password
   - `mfa_seed` — TOTP seed (only if MFA is enabled; remove otherwise)

> `users.json` is gitignored — never commit it.

## Step 4 — Record Scripts in BC

Open any BC page → **Settings ⚙️ → Page Scripting** → Record your process → Save as `.yml`.

For workflows that capture values (e.g. PO number), add a `copy-value` step at the end of the recording.

See [page-scripting/PAGE_SCRIPTING_QUICK_START.md](page-scripting/PAGE_SCRIPTING_QUICK_START.md) for full recording instructions.

## Step 5 — Run

**Multi-user workflow:**
```powershell
cd bc-replay
.\Run-BCWorkflow.ps1 -WorkflowPath "..\page-scripting\PO Approval Workflow"
```

**Single-user variant batch test:**
```powershell
cd page-scripting
.\Generate-BC-Script-Variants.ps1 `
    -BaseScriptPath ".\MyProject\BASE Recording.yml" `
    -ProjectFolder ".\MyProject" `
    -OutputFolder ".\MyProject\Variants"

cd ..\bc-replay
.\npx-run.ps1 -ScriptPath "..\page-scripting\MyProject\Variants\*.yml" `
    -BcUrl "https://businesscentral.dynamics.com/tenant/Sandbox"
```

## Repository Structure

- **`page-scripting/`** - Script generation and variant automation
  - PowerShell generators and project folders
  - Workflow projects with multi-user step definitions

- **`bc-replay/`** - Test execution
  - `Run-BCWorkflow.ps1` — multi-user workflow orchestrator
  - `npx-run.ps1` — single-user variant batch runner

- **`tools/workflow-builder/`** - Visual Workflow Builder (open `index.html` in browser)

- **`docs/`** - Visual overview and architecture

## Next Steps

- **[docs/OVERVIEW.md](docs/OVERVIEW.md)** - Visual walkthrough with screenshots
- **[page-scripting/PAGE_SCRIPTING_QUICK_START.md](page-scripting/PAGE_SCRIPTING_QUICK_START.md)** - BC recording guide
- **[bc-replay/BC_REPLAY_QUICK_START.md](bc-replay/BC_REPLAY_QUICK_START.md)** - Execution and MFA setup
- **[SECURITY.md](SECURITY.md)** - Security guidelines
- **[page-scripting/PO Approval Workflow/](page-scripting/PO%20Approval%20Workflow/)** - Working multi-user example

## Quick Troubleshooting

| Issue | Check |
|-------|-------|
| `setup.ps1` fails | Follow the fix hint printed next to each failed check |
| Script fails | Test data exists in BC? Account has permissions? |
| Workflow stops with validation errors | Read the error list — it tells you exactly what to fix |
| Variants not generated correctly | Check warnings from the generator — field captions may differ |