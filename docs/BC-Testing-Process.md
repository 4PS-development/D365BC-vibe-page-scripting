---
marp: true
theme: default
paginate: true
backgroundColor: #fff
style: |
  section {
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  }
  h1 {
    color: #0078d4;
  }
  h2 {
    color: #243a5e;
  }
  code {
    background: #f0f0f0;
    border-radius: 4px;
  }
  table {
    font-size: 0.85em;
  }
  .small {
    font-size: 0.75em;
  }
  section.lead h1 {
    font-size: 2.2em;
  }
  section.lead h2 {
    font-size: 1.3em;
    color: #666;
  }
  blockquote {
    border-left: 4px solid #0078d4;
    padding-left: 1em;
    color: #555;
  }
---

<!-- _class: lead -->

# Business Central Page Scripting
## Automated Testing Process & CI/CD Pipeline

**Record once. Generate variants. Test everything.**

---

# Agenda

1. What is Page Scripting?
2. The Testing Process
3. Single-User Variant Testing
4. Multi-User Workflow Testing
5. CI/CD Pipeline Architecture
6. Reporting & Quality Gates
7. Getting Started

---

# What is BC Page Scripting?

BC's built-in **Page Scripting** tool records user interactions as structured YAML files.

- Open any page → **Settings** → **Page Scripting** → Record
- Captures field inputs, action clicks, page navigation
- Replays recordings with real-time pass/fail feedback
- Supports parameters, conditionals, validations, and included scripts

> **Primary use case:** User Acceptance Testing (UAT) — validate that business processes work as expected after changes or updates.

Source: [Microsoft Learn — Page Scripting](https://learn.microsoft.com/dynamics365/business-central/dev-itpro/developer/devenv-page-scripting)

---

# bc-replay: Pipeline Execution

**`@microsoft/bc-replay`** is Microsoft's npm package that executes page scripts outside the BC web client using **Playwright**.

```powershell
# Install
npm install @microsoft/bc-replay --save

# Run a script
npx replay .\recordings\my-test.yml `
    -StartAddress https://businesscentral.dynamics.com/tenant/env `
    -Authentication AAD `
    -UserNameKey BC_USERNAME -PasswordKey BC_PASSWORD

# View results
npx playwright show-report
```

Supports: Windows Auth, Entra ID, UserPassword, and **native TOTP MFA**.

---

# The Testing Process — Overview

```
  Record           Generate          Execute           Report
 ┌──────┐        ┌──────────┐      ┌──────────┐     ┌──────────┐
 │ BC   │───────>│ Variants │─────>│ bc-replay│────>│Playwright│
 │ Page │  YAML  │ or       │ YAML │ + multi- │     │ HTML     │
 │Script│  file  │ Workflow │files │ user     │     │ Reports  │
 │ Tool │        │ Builder  │      │ orchestr.│     │ + JSON   │
 └──────┘        └──────────┘      └──────────┘     └──────────┘
```

Two testing modes:

| Mode | Use case | Tool |
|------|----------|------|
| **Single-user variants** | Test one process with many data combinations | `npx-run.ps1` |
| **Multi-user workflows** | Test processes spanning multiple roles | `Run-BCWorkflow.ps1` |

---

# Step 1 — Record in Business Central

1. Open any BC page
2. Go to **Settings** → **Page Scripting**
3. Record your business process (inputs, actions, navigations)
4. Optionally add **validations**, **parameters**, and **copy-value** steps
5. Save as `.yml` file

### Prerequisites

| Permission Set | Purpose |
|----------------|---------|
| `PAGESCRIPTING - REC` | Record scripts |
| `PAGESCRIPTING - PLAY` | Play back scripts |

---

# Step 2a — Generate Variants (Single-User)

Turn one BASE recording into dozens of test combinations:

```
BASE Recording.yml  +  Items.txt  +  Locations.txt
           ↓
  Variants/
    PO-Variant-1896S-BLUE.yml
    PO-Variant-1896S-SILVER.yml
    PO-Variant-LS81-BLUE.yml
    ...
```

```powershell
.\Generate-BC-Script-Variants.ps1 `
    -BaseScriptPath ".\MyProject\BASE Recording.yml" `
    -ProjectFolder ".\MyProject" `
    -OutputFolder  ".\MyProject\Variants"
```

Data files are plain text, one value per line — Items, Locations, Vendors.

---

# Step 2b — Design a Workflow (Multi-User)

For processes spanning multiple roles, use the **visual Workflow Builder**:

1. Open `tools/workflow-builder/index.html` in any browser
2. Define user roles (purchaser, approver, warehouse)
3. Assign scripts to steps
4. Wire capture/inject rules for state passing
5. Export `workflow.json`

```json
{
  "name": "Purchase Order Approval",
  "steps": [
    { "id": "create-po", "user": "purchaser",
      "script": "./scripts/create-po.yml",
      "capture": { "po_number": "Purchase Order - No." } },
    { "id": "approve-po", "user": "approver",
      "script": "./scripts/approve-po.yml",
      "inject": { "PO No.": "{capture.create-po.po_number}" } }
  ]
}
```

---

# Step 3 — Execute Tests

### Single-user batch

```powershell
cd bc-replay
.\npx-run.ps1 `
    -ScriptPath "..\page-scripting\MyProject\Variants\*.yml" `
    -BcUrl "https://businesscentral.dynamics.com/tenant/env"
```

### Multi-user workflow

```powershell
cd bc-replay
.\Run-BCWorkflow.ps1 `
    -WorkflowPath "..\page-scripting\PO Approval Workflow"
```

The orchestrator:
- Reads `workflow.json` for step definitions
- Switches credentials per step via `users.json`
- Captures values (e.g. PO number) and injects into next step
- Generates per-step Playwright reports + workflow summary

---

# Multi-User Workflow — Under the Hood

```
┌─────────────────────────────────────────────────────────┐
│              Workflow Orchestrator (PowerShell)          │
│    Reads: workflow.json · users.json · app-registrations│
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Step 1: Create PO         Step 2: Approve PO           │
│  ┌─────────────────┐      ┌─────────────────┐          │
│  │ User: purchaser  │      │ User: approver   │          │
│  │ Script: create   │──PO#─│ Script: approve  │          │
│  │ Capture: PO No. │      │ Inject:  PO No. │          │
│  └─────────────────┘      └─────────────────┘          │
│         │                          │                    │
│  ┌──────┴──────┐           ┌──────┴──────┐             │
│  │ Playwright  │           │ Playwright  │             │
│  │ Report      │           │ Report      │             │
│  └─────────────┘           └─────────────┘             │
└─────────────────────────────────────────────────────────┘
```

Also supports **bc-api** steps for direct API calls (e.g. create test data).

---

# Step 4 — Reporting

### Per-step: Playwright HTML Report
- Detailed pass/fail per action
- Screenshots and replay logs
- Standard Playwright format — familiar to any test engineer

### Workflow level: Summary Report
- HTML + JSON output
- Status per step with duration
- Links to individual Playwright reports
- Overall PASSED/FAILED verdict

### Quality Evaluation
`Test-WorkflowQuality.ps1` performs static analysis:
- **Pass A:** Per-script YAML analysis (missing validations, orphaned params)
- **Pass B:** Workflow-level analysis (capture-inject chain, dependency integrity)
- **Pass C:** Best-practice scoring with quality grades

---

# CI/CD Pipeline Architecture

```
 ┌─────────────────────────────────────────────────────────────────┐
 │                    GitHub Actions / Azure DevOps                 │
 ├─────────────────────────────────────────────────────────────────┤
 │                                                                 │
 │  ┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌────────────┐ │
 │  │ Checkout  │─>│ Install deps │─>│ Run tests│─>│ Publish    │ │
 │  │ repo      │  │ npm install  │  │ bc-replay│  │ reports    │ │
 │  └──────────┘  └──────────────┘  └──────────┘  └────────────┘ │
 │                                       │                        │
 │                                  ┌────┴────┐                   │
 │                                  │ Quality │                   │
 │                                  │ gate    │                   │
 │                                  └─────────┘                   │
 └─────────────────────────────────────────────────────────────────┘
```

---

# Pipeline — GitHub Actions Example

```yaml
name: BC Acceptance Tests
on:
  schedule:
    - cron: '0 6 * * 1-5'  # Weekdays at 06:00 UTC
  workflow_dispatch:

jobs:
  test:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with: { node-version: '20' }

      - name: Install dependencies
        run: npm ci
        working-directory: bc-replay

      - name: Run workflow tests
        working-directory: bc-replay
        env:
          BC_PURCHASER_USER: ${{ secrets.BC_PURCHASER_USER }}
          BC_PURCHASER_PASS: ${{ secrets.BC_PURCHASER_PASS }}
          BC_APPROVER_USER:  ${{ secrets.BC_APPROVER_USER }}
          BC_APPROVER_PASS:  ${{ secrets.BC_APPROVER_PASS }}
        run: |
          pwsh -File Run-BCWorkflow.ps1 `
            -WorkflowPath "..\page-scripting\PO Approval Workflow"
```

---

# Pipeline — GitHub Actions (cont.)

```yaml
      - name: Quality evaluation
        if: always()
        working-directory: bc-replay
        run: |
          pwsh -File Test-WorkflowQuality.ps1 `
            -WorkflowPath "..\page-scripting\PO Approval Workflow"

      - name: Publish Playwright report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-reports
          path: |
            page-scripting/PO Approval Workflow/results/
          retention-days: 30

      - name: Publish JUnit results
        if: always()
        uses: dorny/test-reporter@v1
        with:
          name: BC Test Results
          path: page-scripting/PO Approval Workflow/results/**/results.xml
          reporter: java-junit
```

---

# Pipeline — Azure DevOps Example

```yaml
trigger: none
schedules:
  - cron: '0 6 * * 1-5'
    displayName: 'Weekday morning run'

pool:
  vmImage: 'windows-latest'

steps:
  - task: NodeTool@0
    inputs: { versionSpec: '20.x' }

  - script: npm ci
    workingDirectory: bc-replay

  - pwsh: |
      .\Run-BCWorkflow.ps1 `
        -WorkflowPath "..\page-scripting\PO Approval Workflow"
    workingDirectory: bc-replay
    env:
      BC_PURCHASER_USER: $(BC_PURCHASER_USER)
      BC_PURCHASER_PASS: $(BC_PURCHASER_PASS)
      BC_APPROVER_USER:  $(BC_APPROVER_USER)
      BC_APPROVER_PASS:  $(BC_APPROVER_PASS)

  - task: PublishTestResults@2
    inputs:
      testResultsFormat: JUnit
      testResultsFiles: '**/results.xml'
    condition: always()
```

---

# Reporting in the Pipeline

| Artifact | Format | Purpose |
|----------|--------|---------|
| **Playwright report** | HTML | Detailed per-step results with screenshots |
| **Workflow summary** | HTML + JSON | Overall workflow status and step breakdown |
| **JUnit XML** | `results.xml` | Standard test results for CI/CD dashboards |
| **Quality report** | HTML + JSON | Static analysis scoring and recommendations |

### Quality gates you can enforce

- **All steps passed** — workflow-summary.json `overall == "PASSED"`
- **Quality score threshold** — evaluation-report.json grade check
- **No error-severity findings** — from `Test-WorkflowQuality.ps1`
- **Maximum duration** — fail if workflow takes too long

---

# Test Result Flow

```
                  ┌──────────────────────────────────────┐
                  │      Run-BCWorkflow.ps1               │
                  └┬──────────┬──────────┬───────────────┘
                   │          │          │
            ┌──────▼───┐ ┌───▼────┐ ┌───▼────┐
            │ Step 1   │ │ Step 2 │ │ Step 3 │
            │ Report   │ │ Report │ │ Report │  ← Playwright HTML
            └──────┬───┘ └───┬────┘ └───┬────┘
                   │         │          │
                   ▼         ▼          ▼
            ┌────────────────────────────────┐
            │   workflow-summary.html/json    │  ← Aggregated view
            └────────────────────────────────┘
                            │
                            ▼
            ┌────────────────────────────────┐
            │   evaluation-report.html/json   │  ← Quality scoring
            └────────────────────────────────┘
                            │
                            ▼
              CI/CD Dashboard (JUnit XML)
```

---

# Security Considerations

| Concern | Approach |
|---------|----------|
| **Credentials** | Stored as CI/CD secrets (not in code); `users.json` is gitignored |
| **MFA accounts** | Supported natively via `-MultiFactorType TOTP` with TOTP seed |
| **API keys** | `app-registrations.json` is gitignored; use sample file as template |
| **Test environments** | Use Sandbox environments — never run against Production |
| **Password handling** | `Read-Host -AsSecureString` for local; env vars for pipelines |

> Credentials are only held in memory during execution — never written to disk or logs.

---

# Project Structure

```
D365BC-vibe-page-scripting/
├── page-scripting/              ← Script generation & workflows
│   ├── Generate-BC-Script-Variants.ps1
│   └── PO Approval Workflow/   ← Example multi-user workflow
│       ├── workflow.json
│       ├── users.sample.json
│       ├── scripts/
│       └── results/
├── bc-replay/                   ← Test execution
│   ├── npx-run.ps1             ← Single-user runner
│   ├── Run-BCWorkflow.ps1      ← Multi-user orchestrator
│   ├── New-WorkflowReport.ps1  ← Report generation
│   └── Test-WorkflowQuality.ps1← Quality evaluation
├── tools/
│   └── workflow-builder/        ← Visual workflow designer
└── docs/                        ← Documentation
```

---

# Getting Started — Quick Path

### 1. Setup
```powershell
.\setup.ps1          # checks prerequisites, installs deps
```

### 2. Design workflow
Open `tools/workflow-builder/index.html` in a browser

### 3. Record scripts
BC → Settings → Page Scripting → Record → Save `.yml`

### 4. Configure credentials
Copy `users.sample.json` → `users.json`, fill in real values

### 5. Run
```powershell
cd bc-replay
.\Run-BCWorkflow.ps1 -WorkflowPath "..\page-scripting\MyWorkflow"
```

### 6. Review
Open `results/workflow-summary.html` or `npx playwright show-report`

---

# Key References

| Resource | Link |
|----------|------|
| BC Page Scripting Docs | [learn.microsoft.com/...devenv-page-scripting](https://learn.microsoft.com/dynamics365/business-central/dev-itpro/developer/devenv-page-scripting) |
| bc-replay npm package | [npmjs.com/@microsoft/bc-replay](https://www.npmjs.com/package/@microsoft/bc-replay) |
| Playwright framework | [playwright.dev](https://playwright.dev/) |
| BC Release Plan (bc-replay) | [learn.microsoft.com/...run-page-scripts-pipelines](https://learn.microsoft.com/dynamics365/release-plan/2024wave2/smb/dynamics365-business-central/run-page-scripts-pipelines-automated-testing) |
| MS Learn Training Module | [learn.microsoft.com/training/...test-automation](https://learn.microsoft.com/training/modules/test-automation/) |
| This project | [github.com/4PS-development/D365BC-vibe-page-scripting](https://github.com/4PS-development/D365BC-vibe-page-scripting) |

---

<!-- _class: lead -->

# Summary

**Record** scripts in BC's Page Scripting tool
**Generate** variants or design multi-user workflows
**Execute** via bc-replay in local or CI/CD pipelines
**Report** with Playwright HTML, workflow summaries, and quality scores
**Gate** your pipeline on test results and quality thresholds

> Automate your BC acceptance testing end-to-end.
