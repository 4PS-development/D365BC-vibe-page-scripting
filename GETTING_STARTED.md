# Getting Started with BC Page Script Variants

Get up and running with BC page automation in 15 minutes.

## 📋 What You Need

- Business Central test environment (Sandbox)
- Test account with permissions (MFA disabled **OR** TOTP-based MFA - see [MFA support](bc-replay/bc-replay-mfa-solution/))
- PowerShell, Git, and BC Page Scripting tool (Playwright-based bc-replay)

⚠️ **Important:** Configure credentials first - see [SECURITY.md](SECURITY.md)

💡 **Note:** This project supports both standard authentication and MFA accounts using TOTP (Authenticator app). For TOTP setup instructions, see [README.md - TOTP Account Setup](README.md#-setting-up-totp-for-test-accounts).

⚠️ **TOTP Critical Warning:** If setting up TOTP, you **MUST** capture the seed during initial setup - it's **ONLY shown ONCE** and can never be retrieved later!

## 🚀 Setup (5 Minutes)

1. **Clone the repository**
   ```bash
   git clone https://github.com/andywingate/D365BC-vibe-page-scripting.git
   cd D365BC-vibe-page-scripting
   ```

2. **Configure environment**  
   Edit `bc-replay/npx-run.ps1` with your BC tenant, environment, and test account details

3. **Verify test data**  
   Ensure test vendors, items, and locations exist in your BC test company

## 📂 Repository Structure

- **`page-scripting/`** - Scripts and automation
  - PowerShell generators
  - Project folders with BASE recordings and data files
  - Workflow projects (e.g., `PO Approval Workflow/`) with multi-user step definitions
  
- **`bc-replay/`** - Test execution
  - Test runner and Playwright environment
  - Workflow orchestrator (`Run-BCWorkflow.ps1`)
  - YAML preprocessor and report generator

- **`docs/`** - Architecture and planning
  - Multi-user workflow plan and research

## 🎯 Create Your First Variants (10 Minutes)

### 1. Study an Example
Look at `page-scripting/PO Post DirectionsEMEA/` to see:
- A BASE recording
- Data files (Items, Locations)
- Generated variants

**Concept:** 1 BASE recording + data files = multiple test variants

### 2. Create Your Project
```powershell
cd page-scripting
mkdir "MyProject"
```

### 3. Add Your Files
- Record a BASE script using BC's recorder → save as `BASE Recording.yml`
- Create data files: `Items` and `Locations` (plain text, one value per line)

### 4. Generate Variants
```powershell
.\Generate-BC-Script-Variants.ps1 `
    -BaseScriptPath ".\MyProject\BASE Recording.yml" `
    -ProjectFolder ".\MyProject" `
    -OutputFolder ".\MyProject\Variants"
```

### 5. Run Tests
```powershell
cd ..\bc-replay
.\npx-run.ps1
```

## 📚 Next Steps

- **[README.md](README.md)** - Detailed patterns, methodology, and best practices
- **[page-scripting/PAGE_SCRIPTING_QUICK_START.md](page-scripting/PAGE_SCRIPTING_QUICK_START.md)** - BC recording guide
- **[bc-replay/BC_REPLAY_QUICK_START.md](bc-replay/BC_REPLAY_QUICK_START.md)** - Test execution guide
- **[SECURITY.md](SECURITY.md)** - Security configuration
- **`.github/copilot-instructions.md`** - YAML patterns and examples
- **Multi-user workflows** - See below
- **Example projects** - Study the working examples in `page-scripting/`

## 👥 Multi-User Workflows

Once you're comfortable with single-user variant generation, you can orchestrate multi-user workflows where different BC users act in sequence.

### Concept

```
Purchaser creates PO  →  Approver approves PO  →  Warehouse receives goods
   (User A)                   (User B)                  (User C)
```

Each step runs as a separate bc-replay invocation with its own credentials. Captured values (like a PO number) are injected into the next step's BC native `parameters:` section.

### Quick Start

1. **Study the example** - See `page-scripting/PO Approval Workflow/` for the structure
2. **Define users** - Create `users.json` with credentials for each role
3. **Define workflow** - Create `workflow.json` with steps, scripts, and capture/inject rules
4. **Record scripts** - Record scripts with BC's native parameter support (`Parameters.'Page.Field'`)
5. **Run** -
   ```powershell
   cd bc-replay
   .\Run-BCWorkflow.ps1 -WorkflowPath "..\page-scripting\PO Approval Workflow"
   ```

See [docs/MULTI-USER-WORKFLOW-PLAN.md](docs/MULTI-USER-WORKFLOW-PLAN.md) for full architecture details.

## Quick Troubleshooting

| Issue | Check |
|-------|-------|
| Script fails | Test data exists in BC? Account has permissions? |
| Variants not generated | Data files formatted correctly (plain text, one per line)? |
| Need help | See [README.md](README.md) Troubleshooting section |