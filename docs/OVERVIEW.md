# Business Central Page Scripting — Solution Overview

Automate Business Central acceptance testing: record once, generate many variants, run them all.

---

## What This Solution Does

Business Central's built-in **Page Scripting** tool lets you record a user journey as a YAML file. This project builds on that foundation to:

1. **Generate test variants** — one BASE recording produces dozens of test combinations automatically
2. **Orchestrate multi-user workflows** — chain steps across different user roles (e.g. purchaser → approver)
3. **Run tests in pipelines** — execute and report via bc-replay (Playwright-based)

---

## Step 1 — Record in Business Central

Open any BC page, go to **Settings ⚙️ → Page Scripting**, and record your business process.

![BC Page Scripting pane open during a recording](images/01-bc-page-scripting-pane.png)

> The pane captures every field input, action click, and page navigation as structured YAML steps.

---

## Step 2 — The BASE Script (YAML)

Each recording is saved as a `.yml` file. This is your **BASE script** — the single source of truth for a process.

![BASE recording open in VS Code](images/02-yml-script-vscode.png)

> Only specific field values (item, vendor, location) are substituted during variant generation. The YAML structure is never touched.

---

## Step 3 — Create a Workflow (optional)

For processes that span multiple users, use the **Workflow Builder** to visually wire scripts together — no JSON editing required. Define user roles, assign scripts to steps, and export a ready-to-run `workflow.json`.

![Workflow Builder — visual tool for wiring scripts into a multi-user workflow](images/06-workflow-builder.png)

> Open `tools/workflow-builder/index.html` in any browser. Import an existing `workflow.json` or build from scratch.

---

## Step 4 — Generate Variants

Run the PowerShell generator with data files (one value per line) to produce a variant for every combination.

```
BASE Recording.yml  +  Items (file)  +  Locations (file)
          ↓
  Variants/
    PO-Variant-1896S-BLUE.yml
    PO-Variant-1896S-SILVER.yml
    PO-Variant-LS-81-BLUE.yml
    ...
```


## Step 5 — Test Results

After running, Playwright produces a full HTML report showing which tests passed or failed.

![Playwright HTML test report — summary view](images/04-playwright-report.png)

![Playwright HTML test report — detail view](images/04b-playwright-report-detail.png)

---

## Multi-User Workflows

Some processes span multiple users — for example, a **purchaser** creates a Purchase Order and an **approver** approves it. Once the workflow is configured (see Step 3), the orchestrator runs each step under its own credentials, passing captured values (like the PO number) between steps automatically.

![Workflow summary report showing multi-user steps](images/05-workflow-summary-report.png)

> The HTML summary report shows the status of every step in the chain.

---

## Key Concepts at a Glance

| Concept | What it means |
|---------|--------------|
| **BASE script** | A single tested recording for a business process |
| **Variant** | A copy of the BASE script with different field values substituted |
| **Data files** | Plain text files (one value per line) — Items, Locations, Vendors |
| **bc-replay** | Playwright-based runner that executes YAML scripts outside the BC client |
| **Workflow** | A sequence of scripts run across different users, with value passing between steps |

---

## Where to Go Next

| I want to… | Go here |
|------------|---------|
| Get set up fast | [GETTING_STARTED.md](../GETTING_STARTED.md) |
| Design a workflow visually | [tools/workflow-builder/index.html](../tools/workflow-builder/index.html) |
| Record my first script | [page-scripting/PAGE_SCRIPTING_QUICK_START.md](../page-scripting/PAGE_SCRIPTING_QUICK_START.md) |
| Run scripts in a pipeline | [bc-replay/BC_REPLAY_QUICK_START.md](../bc-replay/BC_REPLAY_QUICK_START.md) |

---

> **Disclaimer:** This project is created for demo and research purposes only. Use at your own risk.
