# BC-Replay Test Runner

Execute Business Central page scripting YAML files in automated pipelines using Playwright.

## 🚀 Standard BC-Replay (No MFA)

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
|------|---------|-------|
| `Run-BCWorkflow.ps1` | Orchestrator - executes workflow steps sequentially |
| `Invoke-YamlPreprocess.ps1` | Updates native BC parameter `default:` values in YAML |
| `New-WorkflowReport.ps1` | Generates workflow summary report (HTML + JSON) |

📖 See [PO Approval Workflow](../page-scripting/PO%20Approval%20Workflow/) for a working example  
📖 See [MULTI-USER-WORKFLOW-PLAN.md](../docs/MULTI-USER-WORKFLOW-PLAN.md) for architecture details

---

## 🔐 MFA TOTP Support (NEW!)

**Problem:** Your organization requires MFA on all accounts, blocking automation.

**Solution:** Use TOTP (authenticator app) MFA with automated code generation.

### 👉 Complete MFA Solution

**[bc-replay-mfa-solution/](bc-replay-mfa-solution/)** - Everything you need to run bc-replay with MFA-enabled accounts:

- **README.md** - Complete documentation and setup guide
- **SOLUTION.md** - Technical details and approach

### What You'll Need

1. BC account with TOTP MFA enabled (authenticator app)
2. The TOTP seed from account setup (one-time capture - see solution docs)
3. Standard bc-replay installation
4. 5 minutes to apply the patch

### What It Does

✅ Automatically generates TOTP codes during authentication  
✅ Works with Microsoft Entra ID MFA  
✅ Safe fallback for non-MFA accounts  
✅ No changes to your existing scripts  

---

## 📚 Documentation

| Guide | Purpose |
|-------|---------|
| **[BC_REPLAY_QUICK_START.md](BC_REPLAY_QUICK_START.md)** | Standard bc-replay usage (no MFA) |
| **[bc-replay-mfa-solution/](bc-replay-mfa-solution/)** | Complete MFA setup and usage |
| **[bc-replay-capture-solution/](bc-replay-capture-solution/)** | Value capture (superseded by native `copy-value`) |
| **[MULTI-USER-WORKFLOW-PLAN.md](../docs/MULTI-USER-WORKFLOW-PLAN.md)** | Workflow architecture and plan |

---

## 🆘 Need Help?

**Standard bc-replay:** See [BC_REPLAY_QUICK_START.md](BC_REPLAY_QUICK_START.md) troubleshooting section  
**MFA setup:** See [bc-replay-mfa-solution/README.md](bc-replay-mfa-solution/README.md) troubleshooting section

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
├── bc-replay-mfa-solution/      # MFA TOTP patch (for MFA accounts)
├── bc-replay-capture-solution/  # Value capture (superseded by native copy-value)
├── BC_REPLAY_QUICK_START.md     # Standard bc-replay guide
├── README.md                    # This file
└── setup-local-env.ps1.template # Credential template
```

**Development/utility files:**
- `mfa-auth.js`, `test-mfa-auth.js`, `npx-run-mfa.ps1` - MFA development utilities
- `totp-seed-helper.js` - TOTP seed validation tool
- `*.yml` - Example scripts

---

**Ready to automate BC testing?** Start here: **[BC_REPLAY_QUICK_START.md](BC_REPLAY_QUICK_START.md)**
