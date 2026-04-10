# Business Central Page Scripting Project

Automate Business Central page testing using YAML-based scripts executed via Playwright. Record once, generate variants, test multiple combinations.

## ✨ Key Features

- 🔄 **Variant generation** - Automatically create test combinations from data files
- **Multi-user workflows** - Orchestrate sequential steps across different user roles with state passing
- 🔐 **Native MFA support** - Run bc-replay against accounts with MFA enabled using `-MultiFactorType TOTP`
- 🤖 **AI-assisted development** - A methodology for AI script generation

## 🚀 Quick Start

1. **Setup** — Run `.\setup.ps1` from the repo root to check prerequisites and open the Workflow Builder
2. **Design your workflow** — Open [tools/workflow-builder/index.html](tools/workflow-builder/index.html) in a browser: add user roles, drag in scripts, and export `workflow.json`
3. **Record scripts** — See [page-scripting/PAGE_SCRIPTING_QUICK_START.md](page-scripting/PAGE_SCRIPTING_QUICK_START.md) for recording in BC
4. **Run** — See [bc-replay/BC_REPLAY_QUICK_START.md](bc-replay/BC_REPLAY_QUICK_START.md) for execution options
5. **Examples** — Study `page-scripting/PO Post DirectionsEMEA/` (single-user) or `page-scripting/PO Approval Workflow/` (multi-user)
6. **Full Guide** — [GETTING_STARTED.md](GETTING_STARTED.md)

## Project Structure

**`page-scripting/`** - Script generation and variant automation
- PowerShell generators for creating test variants
- Project folders with BASE recordings and data files
- **Workflow projects** with multi-user step definitions
- **`catalog.json`** — 3-level test hierarchy (Waardeketen > Type > Procesflow)
- [PAGE_SCRIPTING_QUICK_START.md](page-scripting/PAGE_SCRIPTING_QUICK_START.md) - Recording guide

**`bc-replay/`** - Test execution including multi-user workflows
- Script runner for automated pipelines
- **Workflow orchestrator** for multi-user sequential execution
- **Catalog runner** for executing workflows by hierarchy filter
- **Native value capture** via BC's `copy-value` step (reads from replay log)
- 📖 [BC_REPLAY_QUICK_START.md](bc-replay/BC_REPLAY_QUICK_START.md) - Execution guide
- 📖 [bc-replay-capture-solution/](bc-replay/bc-replay-capture-solution/) - Value capture (superseded by native `copy-value`)

**`tools/`** - Visual tools
- [workflow-builder/index.html](tools/workflow-builder/index.html) - Visual workflow designer (open in browser — no install needed)

**`docs/`** - Architecture and planning
- [OVERVIEW.md](docs/OVERVIEW.md) - Visual solution overview
- [MULTI-USER-WORKFLOW-PLAN.md](docs/MULTI-USER-WORKFLOW-PLAN.md) - Developer reference: research, architecture, implementation details

## 👥 Multi-User Workflows

Orchestrate BC processes that span multiple users - for example, a purchaser creates a PO, then an approver approves it:

```powershell
# Credentials are stored in users.json per role
# Run the workflow
cd bc-replay
.\Run-BCWorkflow.ps1 -WorkflowPath "..\page-scripting\PO Approval Workflow"
```

Each step runs with its own credentials. Captured values (like a PO number) are automatically injected into the next step's native BC `parameters:` section.

**See [page-scripting/PO Approval Workflow/](page-scripting/PO%20Approval%20Workflow/) for a working example.**

## Test Catalog — 3-Level Hierarchy

Organise workflows into a traceable hierarchy with user-defined codes and names:

| Level | Name | Example Code | Example Name |
|-------|------|-------------|-------------|
| 1 | Waardeketen | `PRJ` | Projecten |
| 2 | Type | `VG` | Vastgoed |
| 3 | Procesflow | `TRAJECT` | Van traject naar project |

**Composite code:** `PRJ-VG-TRAJECT` — used in reports and filtering.

```powershell
# Validate catalog structure
cd bc-replay
.\Test-Catalog.ps1

# Run all workflows under a value chain
.\Run-CatalogWorkflows.ps1 -Filter "PRJ"

# Run a specific type
.\Run-CatalogWorkflows.ps1 -Filter "INK-PO"

# Generate aggregate dashboard
.\New-CatalogReport.ps1
```

The catalog is defined in [page-scripting/catalog.json](page-scripting/catalog.json). Each workflow can include an optional `catalog` block in its `workflow.json` for back-reference.

##  Security

**Before using:**
- Replace placeholder credentials in test scripts
- Update BC URLs with your tenant/environment
- Never commit actual passwords to the repository

📖 **See [SECURITY.md](SECURITY.md) for complete security guidelines and TOTP account setup**

## Documentation

| Guide | Purpose |
|-------|---------|
| **[docs/OVERVIEW.md](docs/OVERVIEW.md)** | Visual overview — start here |
| **[GETTING_STARTED.md](GETTING_STARTED.md)** | Step-by-step setup walkthrough |
| **[tools/workflow-builder/index.html](tools/workflow-builder/index.html)** | Visual Workflow Builder (open in browser) |
| **[SECURITY.md](SECURITY.md)** | Security guidelines and TOTP account setup |
| **[page-scripting/](page-scripting/)** | Recording scripts and variant generation |
| **[bc-replay/](bc-replay/)** | Execution and multi-user workflows |
| **[.github/copilot-instructions.md](.github/copilot-instructions.md)** | AI agent instructions and YAML patterns |

## 🔗 Resources

- [BC Page Scripting Docs](https://learn.microsoft.com/dynamics365/business-central/dev-itpro/developer/devenv-page-scripting) - Official Microsoft documentation
- [BC-Replay Package](https://www.npmjs.com/package/@microsoft/bc-replay) - npm package for pipeline execution  
- [Playwright](https://playwright.dev/) - Underlying test automation framework
- [Blog: AI-Driven Page Scripting](https://blog.wingate365.com/2025/10/south-coast-summit-2025-ai-driven-page.html) - Methodology deep dive

---

> ⚠️ **Disclaimer:** This project is created for demonstration and research purposes only. Use at your own risk.
