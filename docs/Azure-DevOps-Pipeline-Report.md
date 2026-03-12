---
marp: true
theme: default
paginate: true
backgroundColor: #fff
style: |
  section {
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  }
  h1 { color: #0078d4; }
  h2 { color: #243a5e; }
  h3 { color: #333; }
  code { background: #f0f0f0; border-radius: 4px; }
  table { font-size: 0.82em; }
  section.lead h1 { font-size: 2.2em; }
  section.lead h2 { font-size: 1.3em; color: #666; }
  blockquote { border-left: 4px solid #0078d4; padding-left: 1em; color: #555; }
  .mockup { background: #f8f8f8; border: 2px solid #ddd; border-radius: 8px; padding: 16px; font-size: 0.82em; }
  .pass { color: #22c55e; font-weight: bold; }
  .fail { color: #D0021B; font-weight: bold; }
  .warn { color: #eab308; font-weight: bold; }
  .badge-pass { background: #22c55e; color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 0.8em; font-weight: 600; }
  .badge-fail { background: #D0021B; color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 0.8em; font-weight: 600; }
  .devops-header { background: #0078d4; color: #fff; padding: 4px 12px; border-radius: 4px 4px 0 0; font-size: 0.85em; font-weight: 600; }
  .devops-body { background: #fff; border: 1px solid #ddd; border-top: none; padding: 12px; border-radius: 0 0 4px 4px; }
---

<!-- _class: lead -->

# Azure DevOps Pipeline Report
## BC Page Scripting — How Test Results Appear in DevOps

What the pipeline produces and where to find it

---

# Pipeline Overview — What Gets Published

The BC testing pipeline produces **four report layers** in Azure DevOps:

| Layer | DevOps Location | Source |
|-------|----------------|--------|
| **Pipeline run summary** | Run overview tab | Pipeline YAML stages/steps |
| **Test results** | Tests tab | `PublishTestResults` from JUnit XML |
| **Workflow summary** | Published artifact | `workflow-summary.html` + `.json` |
| **Playwright reports** | Published artifact | Per-step HTML reports |
| **Quality evaluation** | Published artifact | `evaluation-report.html` + `.json` |

> Each layer serves a different audience: DevOps dashboard for PMs, detailed HTML for testers, JSON for automation.

---

# The Complete Pipeline YAML

```yaml
trigger: none

schedules:
  - cron: '0 6 * * 1-5'
    displayName: 'Weekday morning run'
    branches:
      include: [main]

pool:
  vmImage: 'windows-latest'

variables:
  - group: 'BC-Test-Credentials'   # Variable group with secrets
  - name: workflowPath
    value: 'page-scripting/PO Approval Workflow'
```

---

# Pipeline Stages

```yaml
stages:
  - stage: Test
    displayName: 'BC Acceptance Tests'
    jobs:
      - job: RunWorkflow
        displayName: 'Execute BC Workflow'
        timeoutInMinutes: 30
        steps:
          - task: NodeTool@0
            displayName: 'Install Node.js 20'
            inputs:
              versionSpec: '20.x'

          - script: npm ci
            displayName: 'Install bc-replay'
            workingDirectory: bc-replay

          - pwsh: |
              .\Run-BCWorkflow.ps1 `
                -WorkflowPath "..\$(workflowPath)"
            displayName: 'Run workflow tests'
            workingDirectory: bc-replay
            env:
              BC_PURCHASER_USER: $(BC_PURCHASER_USER)
              BC_PURCHASER_PASS: $(BC_PURCHASER_PASS)
              BC_APPROVER_USER:  $(BC_APPROVER_USER)
              BC_APPROVER_PASS:  $(BC_APPROVER_PASS)
```

---

# Pipeline — Reporting Steps

```yaml
          - pwsh: |
              .\Test-WorkflowQuality.ps1 `
                -WorkflowPath "..\$(workflowPath)"
            displayName: 'Quality evaluation'
            condition: always()
            workingDirectory: bc-replay

          - task: PublishTestResults@2
            displayName: 'Publish JUnit results'
            condition: always()
            inputs:
              testResultsFormat: 'JUnit'
              testResultsFiles: '**/results.xml'
              searchFolder: '$(workflowPath)/results'
              mergeTestResults: true
              testRunTitle: 'BC Acceptance Tests'

          - task: PublishPipelineArtifact@1
            displayName: 'Publish test reports'
            condition: always()
            inputs:
              targetPath: '$(workflowPath)/results'
              artifact: 'bc-test-reports'
```

---

# Pipeline — Quality Gate

```yaml
          - pwsh: |
              $summary = Get-Content "$(workflowPath)/results/workflow-summary.json" `
                -Raw | ConvertFrom-Json
              
              if ($summary.overall -ne "PASSED") {
                Write-Error "Workflow FAILED: $($summary.failed) of $($summary.total_steps) steps failed"
                exit 1
              }
              
              $eval = Get-Content "$(workflowPath)/results/evaluation-report.json" `
                -Raw | ConvertFrom-Json
              
              if ($eval.overall_score -lt 60) {
                Write-Warning "Quality score $($eval.overall_score)/100 (Grade: $($eval.grade)) — below threshold"
              }
              
              Write-Host "All $($summary.total_steps) steps PASSED in $($summary.duration_s)s"
              Write-Host "Quality score: $($eval.overall_score)/100 (Grade: $($eval.grade))"
            displayName: 'Quality gate check'
            condition: always()
```

---

# DevOps — Run Summary View

What you see when opening a pipeline run:

```
┌─────────────────────────────────────────────────────────────────┐
│  BC Acceptance Tests > Run #247                                 │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                                 │
│  Status: ✅ Succeeded         Duration: 1m 42s                  │
│  Branch: main                 Triggered: Schedule (06:00 UTC)   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ BC Acceptance Tests                                     │    │
│  │ ├─ ✅ Install Node.js 20              0m 12s            │    │
│  │ ├─ ✅ Install bc-replay               0m 18s            │    │
│  │ ├─ ✅ Run workflow tests              1m 16s            │    │
│  │ ├─ ✅ Quality evaluation              0m 04s            │    │
│  │ ├─ ✅ Publish JUnit results           0m 02s            │    │
│  │ ├─ ✅ Publish test reports            0m 03s            │    │
│  │ └─ ✅ Quality gate check              0m 01s            │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  [Summary]  [Tests]  [Artifacts]  [Logs]                        │
└─────────────────────────────────────────────────────────────────┘
```

---

# DevOps — Run Summary (Failed Run)

```
┌─────────────────────────────────────────────────────────────────┐
│  BC Acceptance Tests > Run #248                                 │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                                 │
│  Status: ❌ Failed            Duration: 1m 08s                  │
│  Branch: main                 Triggered: Manual                 │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ BC Acceptance Tests                                     │    │
│  │ ├─ ✅ Install Node.js 20              0m 12s            │    │
│  │ ├─ ✅ Install bc-replay               0m 18s            │    │
│  │ ├─ ❌ Run workflow tests              0m 52s            │    │
│  │ ├─ ✅ Quality evaluation              0m 04s            │    │
│  │ ├─ ✅ Publish JUnit results           0m 02s            │    │
│  │ ├─ ✅ Publish test reports            0m 03s            │    │
│  │ └─ ❌ Quality gate check              0m 01s            │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  Error: Workflow FAILED: 1 of 3 steps failed                    │
└─────────────────────────────────────────────────────────────────┘
```

---

# DevOps — Tests Tab

The **Tests** tab shows JUnit results from `PublishTestResults@2`:

```
┌─────────────────────────────────────────────────────────────────┐
│  Tests  │  Run #247 — BC Acceptance Tests                       │
│━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                 │
│  Total: 3    ✅ Passed: 3    ❌ Failed: 0    ⏭ Skipped: 0      │
│  Duration: 76.3s                                                │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Test                                    │ Outcome │ Time  │  │
│  ├─────────────────────────────────────────┼─────────┼───────┤  │
│  │ create-po.yml                           │ ✅ Pass │ 42.7s │  │
│  │ Check PO with approver.yml              │ ✅ Pass │ 31.8s │  │
│  │ Create Test Customer via API            │ ✅ Pass │  1.7s │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  📎 Attachments: Replay-log.yml, Recording.yml, video.webm     │
└─────────────────────────────────────────────────────────────────┘
```

---

# DevOps — Tests Tab (Failed)

```
┌─────────────────────────────────────────────────────────────────┐
│  Tests  │  Run #248 — BC Acceptance Tests                       │
│━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                 │
│  Total: 3    ✅ Passed: 2    ❌ Failed: 1    ⏭ Skipped: 0      │
│  Duration: 52.1s                                                │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Test                                    │ Outcome │ Time  │  │
│  ├─────────────────────────────────────────┼─────────┼───────┤  │
│  │ create-po.yml                           │ ✅ Pass │ 42.7s │  │
│  │ Check PO with approver.yml              │ ❌ Fail │  9.4s │  │
│  │ Create Test Customer via API            │ ⏭ Skip │  0.0s │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ❌ Check PO with approver.yml                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Error: Step 4 failed - field 'Status' expected 'Open'   │    │
│  │        but found 'Pending Approval'.                     │    │
│  │        Approval setup may have changed.                  │    │
│  │                                                          │    │
│  │ 📎 Replay-log.yml  📎 video.webm  📎 screenshot.png    │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

---

# DevOps — Tests Tab: Trend Chart

The Tests tab also shows **test result trends** across pipeline runs:

```
  Pass/Fail over last 14 runs
  ─────────────────────────────────────────────────────
  
  3 │ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██
    │ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██
    │ ██ ██ ██ ██ ██ ██ ░░ ██ ██ ██ ██ ██ ░░ ██
  0 └──────────────────────────────────────────────
    #235 ····················· #247  #248
                                          
  ██ Passed   ░░ Failed
  
  Pass rate: 85.7% (12/14 runs fully green)
  Avg duration: 74.2s
```

This appears automatically from `PublishTestResults@2` — no extra configuration needed.

---

# DevOps — Artifacts Tab

Published artifacts from `PublishPipelineArtifact@1`:

```
┌─────────────────────────────────────────────────────────────────┐
│  Artifacts  │  Run #247                                         │
│━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                 │
│  📦 bc-test-reports                                    12.4 MB  │
│  │                                                              │
│  ├── 📄 workflow-summary.json                                   │
│  ├── 📄 workflow-summary.html        ← Open in browser          │
│  ├── 📄 evaluation-report.json                                  │
│  ├── 📄 evaluation-report.html       ← Quality scorecard        │
│  ├── 📄 workflow-state.json                                     │
│  │                                                              │
│  ├── 📁 step-create-po/                                         │
│  │   ├── 📄 results.xml                                         │
│  │   └── 📁 playwright-report/                                  │
│  │       └── 📄 index.html           ← Detailed step report     │
│  │                                                              │
│  ├── 📁 step-approve-po/                                        │
│  │   ├── 📄 results.xml                                         │
│  │   └── 📁 playwright-report/                                  │
│  │       └── 📄 index.html           ← Detailed step report     │
│  │                                                              │
│  └── 📁 step-create-customer/                                   │
│      └── 📄 api-response.json                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

# Artifact: Workflow Summary (HTML)

Download and open `workflow-summary.html` — the aggregated workflow view:

```
┌─────────────────────────────────────────────────────────────────┐
│  ▌4PS▐  BC Workflow Report                                      │
│━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                 │
│  Purchase Order Approval Process                                │
│  ┌────────┐  2026-03-05 11:36:03 — 76.3s total                 │
│  │ PASSED │                                                     │
│  └────────┘                                                     │
│                                                                 │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────────┐                   │
│  │  3   │  │  3   │  │  0   │  │  76.3s   │                   │
│  │Total │  │Passed│  │Failed│  │ Duration │                   │
│  └──────┘  └──────┘  └──────┘  └──────────┘                   │
│                                                                 │
│  ┌────────────┬────────────────────┬───────────┬────────┬─────┐│
│  │ Step       │ Name               │ User      │ Status │ Time││
│  ├────────────┼────────────────────┼───────────┼────────┼─────┤│
│  │ create-po  │ Create PO          │ purchaser │✅ PASS │42.7s││
│  │ approve-po │ Check PO approver  │ approver  │✅ PASS │31.8s││
│  │ create-cust│ Create Customer API│ system    │✅ PASS │ 1.7s││
│  └────────────┴────────────────────┴───────────┴────────┴─────┘│
│                                                                 │
│  Each step links to its own Playwright report →  [View Report]  │
└─────────────────────────────────────────────────────────────────┘
```

---

# Artifact: Quality Evaluation (HTML)

Download and open `evaluation-report.html`:

```
┌─────────────────────────────────────────────────────────────────┐
│  ▌4PS▐  Workflow Quality Evaluator                              │
│━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                 │
│  Purchase Order Approval Process                                │
│  Score: 57/100   Grade: D                                       │
│                                                                 │
│  ┌───────────────────┬───────┐                                  │
│  │ Category          │ Score │                                  │
│  ├───────────────────┼───────┤                                  │
│  │ Validation ratio  │  20%  │  ← Few validate steps            │
│  │ Script coverage   │ 100%  │  ← All scripts referenced        │
│  │ Capture usage     │  25%  │  ← Captures could be validated   │
│  │ Chain integrity   │ 100%  │  ← Inject/capture chain correct  │
│  └───────────────────┴───────┘                                  │
│                                                                 │
│  Findings: 0 errors, 1 warning, 7 info                          │
│                                                                 │
│  ⚠ create-po.yml: Zero validate steps — no assertions verify   │
│    expected outcomes.                                           │
│    → Add validate steps after key actions.                      │
│                                                                 │
│  ℹ create-po.yml: Input to 'Quantity' (line 129) has no        │
│    matching validate step.                                      │
└─────────────────────────────────────────────────────────────────┘
```

---

# Artifact: Playwright Report (Per-Step)

Open `step-create-po/playwright-report/index.html`:

```
┌─────────────────────────────────────────────────────────────────┐
│  ▶ Playwright Test Report                                       │
│━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                 │
│  1 passed  (42.7s)                                              │
│                                                                 │
│  ✅ create-po.yml — chromium                          42.7s     │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Steps:                                                  │    │
│  │  ✅ Navigate to Purchase Orders                         │    │
│  │  ✅ Input "1000" into Vendor No.                        │    │
│  │  ✅ Focus No. field (Purchase Line)                     │    │
│  │  ✅ Input "1896-S" into No. (item)                      │    │
│  │  ✅ Input "10" into Quantity                            │    │
│  │  ✅ Copy value: Purchase Order - No. → "PO-01247"       │    │
│  │  ...                                                    │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  📎 Attachments:                                                │
│    📹 video.webm     📄 Replay-log.yml    📄 Recording.yml     │
└─────────────────────────────────────────────────────────────────┘
```

---

# DevOps — Step Log Output

Clicking a pipeline step shows the console output:

```
┌─────────────────────────────────────────────────────────────────┐
│  Run workflow tests  │  ✅ Succeeded  │  1m 16s                 │
│━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                 │
│  ======================================================        │
│    BC Multi-User Workflow Orchestrator                          │
│  ======================================================        │
│                                                                 │
│    Workflow : Purchase Order Approval Process                   │
│    Steps    : 3                                                 │
│    BC URL   : https://4psconstruct.bc.dynamics.com/.../FpsDemo  │
│    Results  : ..\page-scripting\PO Approval Workflow\results    │
│                                                                 │
│    Validating configuration...                                  │
│    All checks passed.                                           │
│                                                                 │
│  ── Step 1/3: Create Purchase Order (purchaser) ──              │
│    Script: ./scripts/create-po.yml                              │
│    Running bc-replay...                                         │
│    ✅ PASSED (42.7s) — exit code 0                              │
│    Captured: po_number = "PO-01247"                             │
│                                                                 │
│  ── Step 2/3: Check PO with approver (approver) ──             │
│    Script: ./scripts/Check PO with approver.yml                 │
│    Injecting: Purchase Order List.No. = "PO-01247"              │
│    Running bc-replay...                                         │
│    ✅ PASSED (31.8s) — exit code 0                              │
│                                                                 │
│  ── Step 3/3: Create Test Customer via API (system) ──          │
│    Calling POST .../customers                                   │
│    ✅ PASSED (1.7s) — 201 Created                               │
│    Captured: customer_no = "C00412"                             │
│                                                                 │
│  ======================================================        │
│    WORKFLOW PASSED — 3/3 steps passed in 76.3s                  │
│  ======================================================        │
└─────────────────────────────────────────────────────────────────┘
```

---

# DevOps — Quality Gate Log

```
┌─────────────────────────────────────────────────────────────────┐
│  Quality gate check  │  ✅ Succeeded  │  0m 01s                 │
│━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                 │
│  All 3 steps PASSED in 76.3s                                    │
│  Quality score: 57/100 (Grade: D)                               │
│                                                                 │
│  ##[warning] Quality score 57/100 (Grade: D) — below threshold  │
└─────────────────────────────────────────────────────────────────┘
```

The quality gate can be configured to **warn** or **fail** depending on your threshold:

```powershell
# Fail the pipeline if quality is below threshold
if ($eval.overall_score -lt 60) {
    Write-Error "Quality score too low: $($eval.overall_score)/100"
    exit 1  # ← Changes warning to hard gate
}
```

---

# DevOps Dashboard — Widgets

Add test widgets to your Azure DevOps dashboard for at-a-glance status:

```
┌───────────────────────────────────────────────────────────────────────┐
│  4PS BC Testing Dashboard                                             │
├───────────────────┬───────────────────┬───────────────────────────────┤
│                   │                   │                               │
│  BC Acceptance    │  Test Results     │  Test Result Trend            │
│  Tests            │  Trend            │                               │
│                   │                   │    3 ██████████████████████   │
│  Last run: #247   │  Pass Rate        │    2 ██████████████████████   │
│  ✅ Succeeded     │                   │    1 █████████░██████████░█   │
│  3/3 passed       │    92.3%          │    0 ─────────────────────    │
│  76.3s            │    (last 14 runs) │      Mar 1          Mar 12   │
│                   │                   │                               │
├───────────────────┼───────────────────┤  ██ Passed  ░░ Failed        │
│                   │                   │                               │
│  Quality Score    │  Deployment       ├───────────────────────────────┤
│                   │  Frequency        │                               │
│    57 / 100       │                   │  Recent Runs                  │
│    Grade: D       │  5x per week      │  #247 ✅ 76.3s  Mar 12 06:00│
│                   │  (scheduled)      │  #246 ✅ 72.1s  Mar 11 06:00│
│  ⚠ Add validate  │                   │  #245 ✅ 81.4s  Mar 10 06:00│
│    steps to       │                   │  #244 ❌ 52.1s  Mar  9 06:00│
│    improve score  │                   │  #243 ✅ 73.8s  Mar  8 06:00│
│                   │                   │                               │
└───────────────────┴───────────────────┴───────────────────────────────┘
```

---

# DevOps Dashboard Widgets — Setup

To create the dashboard shown above:

| Widget | Source | Configuration |
|--------|--------|---------------|
| **Build History** | Built-in | Select your BC test pipeline |
| **Test Results Trend** | Built-in | Select pipeline, group by "Test Run" |
| **Chart for Test Plans** | Built-in | Outcome pie chart from test results |
| **Deployment Status** | Built-in | Shows scheduled frequency |
| **Markdown** | Built-in | Custom widget for quality score (read JSON) |

### DevOps Widgets to install (free)

- **Test Results Trend (Advanced)** — multi-line trend chart with pass/fail/skip
- **Build Quality Checks** — enforce quality gates via policy

> Add widgets via Dashboard > Edit > Add Widget

---

# Report Flow — End to End

```
  Pipeline Run
       │
       ▼
  ┌──────────────────────────┐
  │ Run-BCWorkflow.ps1       │ ─── Console output → Pipeline logs
  │                          │
  │ Per step:                │
  │  ├─ results.xml          │ ─── JUnit XML → Tests tab
  │  ├─ playwright-report/   │ ─── HTML → Artifact (download)
  │  └─ replay-log.yml       │ ─── Attachment in JUnit
  │                          │
  │ Aggregated:              │
  │  ├─ workflow-summary     │ ─── HTML + JSON → Artifact
  │  └─ workflow-state.json  │ ─── Captured values
  └──────────────────────────┘
       │
       ▼
  ┌──────────────────────────┐
  │ Test-WorkflowQuality.ps1 │
  │  ├─ evaluation-report    │ ─── HTML + JSON → Artifact
  │  └─ Console output       │ ─── Pipeline logs
  └──────────────────────────┘
       │
       ▼
  ┌──────────────────────────┐
  │ Quality Gate             │ ─── Pass/fail entire pipeline
  └──────────────────────────┘
```

---

# Notification Setup

Configure Azure DevOps to notify on test failures:

```
┌─────────────────────────────────────────────────────────────────┐
│  Project Settings > Notifications > New Subscription            │
│━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                 │
│  Template: "A build completes"                                  │
│                                                                 │
│  Filters:                                                       │
│    Build pipeline = BC Acceptance Tests                         │
│    Build status   = Failed                                      │
│                                                                 │
│  Deliver to:                                                    │
│    ☑ Email: bc-testing-team@4ps.nl                              │
│    ☑ Microsoft Teams channel: #bc-test-results                  │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  Teams message preview:                                         │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ ❌ BC Acceptance Tests #248 FAILED                       │    │
│  │ Branch: main | Duration: 1m 08s                          │    │
│  │ 1 of 3 tests failed: Check PO with approver.yml         │    │
│  │ [View run] [View test results]                           │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

---

# Variable Group Setup

Store credentials securely in Azure DevOps:

```
┌─────────────────────────────────────────────────────────────────┐
│  Library > Variable Groups > BC-Test-Credentials                │
│━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                 │
│  Variable              │ Value                     │ Secret     │
│  ──────────────────────┼───────────────────────────┼──────────  │
│  BC_PURCHASER_USER     │ purchaser@tenant.com      │            │
│  BC_PURCHASER_PASS     │ ••••••••••••              │ 🔒         │
│  BC_PURCHASER_MFA_SEED │ ••••••••••••              │ 🔒         │
│  BC_APPROVER_USER      │ approver@tenant.com       │            │
│  BC_APPROVER_PASS      │ ••••••••••••              │ 🔒         │
│  BC_APPROVER_MFA_SEED  │ ••••••••••••              │ 🔒         │
│                                                                 │
│  ⓘ Secret variables are encrypted and not visible in logs.     │
│    Reference in pipeline: $(BC_PURCHASER_PASS)                  │
│    Map to env var in pwsh step:                                 │
│      env:                                                       │
│        BC_PURCHASER_PASS: $(BC_PURCHASER_PASS)                  │
└─────────────────────────────────────────────────────────────────┘
```

---

# Putting It All Together

### What stakeholders see

| Role | What they check | Where |
|------|----------------|-------|
| **Project Manager** | Overall pass/fail, trends | DevOps dashboard widgets |
| **Test Lead** | Which steps failed and why | Tests tab + workflow-summary.html |
| **Tester** | Detailed step replay, screenshots | Playwright report per step |
| **Developer** | Error details, replay logs | Pipeline logs + replay-log.yml |
| **Quality Engineer** | Script coverage, validation gaps | evaluation-report.html |

### Automation cadence

| Trigger | Use case |
|---------|----------|
| **Scheduled (daily)** | Regression — catch environment drift |
| **Manual** | Ad-hoc validation after BC updates |
| **Post-deployment** | Verify new AL extensions don't break processes |

---

<!-- _class: lead -->

# Summary

**DevOps Tests tab** — JUnit results with pass/fail per script
**DevOps Artifacts** — Downloadable HTML reports (workflow + Playwright + quality)
**DevOps Dashboard** — Widgets for trends, pass rate, quality score
**Notifications** — Teams/email alerts on failure
**Quality gates** — Configurable threshold to pass or fail the pipeline
