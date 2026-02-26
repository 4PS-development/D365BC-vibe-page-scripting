# BC-Replay Test Runner

Execute Business Central page scripting YAML files in automated pipelines using Playwright.

## 🚀 Quick Start

### Quick Start

```powershell
# Install bc-replay
npm install @microsoft/bc-replay --save

# Run your scripts
npx replay .\recordings\*.yml -StartAddress https://your-bc-url

# View results
npx playwright show-report
```

### Complete Guide

📖 **[BC_REPLAY_QUICK_START.md](BC_REPLAY_QUICK_START.md)** - Full setup, authentication options, troubleshooting

---

## 👥 Multi-User Workflow Orchestrator

**Problem:** Real BC processes span multiple users - one creates a PO, another approves it, a third receives goods.

**Solution:** The workflow orchestrator runs sequential bc-replay steps, each with different user credentials, passing captured values between steps.

### Quick Start

```powershell
# 1. Create users.json with credentials for each role (see users.sample.json)
# 2. Run the workflow
cd bc-replay
.\Run-BCWorkflow.ps1 -WorkflowPath "..\page-scripting\PO Approval Workflow"
```

### What It Does

- Reads `workflow.json` for step definitions, users, and capture/inject rules
- Supports single script (`"script"`) or multiple scripts (`"scripts"` array) per step
- Switches credentials per step via `users.json` (gitignored, use `users.sample.json` as template)
- Captures values using BC's native `copy-value` step (reads from replay log)
- Injects captured values into the next step's native BC `parameters:` section
- Generates per-step Playwright reports + workflow summary (HTML + JSON)
- Auto-opens the HTML report in browser on completion

### Multi-Script Steps

A step can run multiple scripts sequentially under the same user credentials:

```json
{
  "id": "prepare-po",
  "name": "Prepare and Post PO",
  "user": "purchaser",
  "scripts": [
    "./scripts/create-po.yml",
    "./scripts/post-po.yml"
  ],
  "capture": { "po_number": "Purchase Order - No." }
}
```

- Each script gets its own Playwright report (`step-{id}/script-{n}/playwright-report/`)
- Capture scans all scripts in the step (last value wins for duplicates)
- Failure in any script stops the remaining scripts in that step
- The HTML report shows sub-rows for each script with individual report links
- Use `"script"` (string) for single-script steps - fully backward compatible

### Key Files

| File | Purpose |
|------|--------|
| `Run-BCWorkflow.ps1` | Orchestrator — executes workflow steps sequentially |

**Internal scripts** (used by the orchestrator, not called directly):
- `Invoke-YamlPreprocess.ps1` — updates native BC parameter `default:` values in YAML
- `New-WorkflowReport.ps1` — generates workflow summary report (HTML + JSON)

📖 See [PO Approval Workflow](../page-scripting/PO%20Approval%20Workflow/) for a working example  
📖 See [MULTI-USER-WORKFLOW-PLAN.md](../docs/MULTI-USER-WORKFLOW-PLAN.md) for architecture details

---

## 🔐 MFA Support (Native TOTP)

bc-replay natively supports TOTP-based MFA via built-in parameters - no patches or workarounds needed.

```powershell
$env:BC_USERNAME = "testuser@yourtenant.onmicrosoft.com"
$env:BC_PASSWORD  = "YourPassword123"
$env:BC_MFA_SEED  = "YOUR_TOTP_SEED"

npx replay .\recordings\*.yml `
  -StartAddress https://businesscentral.dynamics.com/tenant/environment `
  -Authentication AAD `
  -UserNameKey BC_USERNAME `
  -PasswordKey BC_PASSWORD `
  -MultiFactorType TOTP `
  -MultiFactorSecretKey BC_MFA_SEED
```

**Requires a TOTP seed** captured once during account MFA setup. See [BC_REPLAY_QUICK_START.md - MFA section](BC_REPLAY_QUICK_START.md#-mfa-support-native-totp) for the full setup guide.

---

## 📚 Documentation

| Guide | Purpose |
|-------|---------|
| **[BC_REPLAY_QUICK_START.md](BC_REPLAY_QUICK_START.md)** | Standard bc-replay usage and MFA setup |
| **[bc-replay-capture-solution/](bc-replay-capture-solution/)** | Value capture (superseded by native `copy-value`) |
| **[MULTI-USER-WORKFLOW-PLAN.md](../docs/MULTI-USER-WORKFLOW-PLAN.md)** | Workflow architecture and plan |

---

## 🆘 Need Help?

**Standard bc-replay:** See [BC_REPLAY_QUICK_START.md](BC_REPLAY_QUICK_START.md) troubleshooting section

**MFA setup:** See [MFA section in BC_REPLAY_QUICK_START.md](BC_REPLAY_QUICK_START.md#-mfa-support-native-totp)

**Resources:**
- [BC-Replay npm Package](https://www.npmjs.com/package/@microsoft/bc-replay)
- [Playwright Documentation](https://playwright.dev/)
- [BC Page Scripting Overview](https://learn.microsoft.com/dynamics365/business-central/dev-itpro/developer/devenv-page-scripting)

---

## What's in This Folder

```
bc-replay/
├── Run-BCWorkflow.ps1           # Multi-user workflow orchestrator
├── Invoke-YamlPreprocess.ps1    # YAML parameter preprocessor (updates BC native defaults)
├── New-WorkflowReport.ps1       # Workflow summary report generator
├── bc-replay-capture-solution/  # Value capture (superseded by native copy-value)
├── BC_REPLAY_QUICK_START.md     # Standard bc-replay guide
├── README.md                    # This file
└── setup-local-env.ps1.template # Credential template
```

**Example scripts:**
- `*.yml` - Example scripts

---

**Ready to automate BC testing?** Start here: **[BC_REPLAY_QUICK_START.md](BC_REPLAY_QUICK_START.md)**
