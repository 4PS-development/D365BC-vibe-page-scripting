# PO Approval Workflow

Multi-user workflow demonstrating sequential Purchase Order processing with different user roles.

## Workflow Steps

| Step | User | Action | State Passed |
|------|------|--------|-------------|
| 1 | Purchaser | Create Purchase Order | Captures PO number |
| 2 | Approver | Check the PO | Receives PO number via native BC `parameters:` |

## Prerequisites

- Two BC user accounts with appropriate permissions
- Purchaser account: can create Purchase Orders
- Approver account: has PO approval authority
- Both accounts exist in the same BC environment

## How to Run

### 1. Configure users.json

Copy `users.sample.json` to `users.json` and fill in credentials for each role:

```json
{
  "purchaser": {
    "username": "purchaser@yourtenant.onmicrosoft.com",
    "password": "your-password",
    "description": "Creates purchase orders"
  },
  "approver": {
    "username": "approver@yourtenant.onmicrosoft.com",
    "password": "your-password",
    "description": "Approves purchase orders"
  }
}
```

> `users.json` is gitignored - never commit real credentials.

### 2. Update workflow.json

Edit `workflow.json` and set `bc_url` to your actual BC URL.

### 3. Record your scripts

The `scripts/` folder contains working recordings. To create your own:

1. **Record `create-po.yml`** - Record a Purchase Order creation in BC, ending with a `copy-value` step to capture the PO number
2. **Record `Check PO with approver.yml`** - Record a PO lookup using `Parameters.'Purchase Order List.No.'` to filter by PO number

### 4. Execute the workflow

```powershell
cd bc-replay
.\Run-BCWorkflow.ps1 -WorkflowPath "..\page-scripting\PO Approval Workflow"
```

### 5. View results

```
results/
  workflow-summary.html     # Overall workflow report
  workflow-summary.json     # Machine-readable results
  step-create-po/           # Playwright report for step 1
  step-approve-po/          # Playwright report for step 2
```

## Creating Your Own Workflow

1. Copy this folder as a template
2. Record BASE scripts for each step in BC
3. Use BC's native `copy-value` step to capture values (e.g., PO number)
4. Use BC's native `parameters:` section with `Parameters.'Page.Field'` for injected values
5. Define steps, users, and capture/inject rules in `workflow.json`
6. Create `users.json` with credentials for each role (copy from `users.sample.json`)

### Multi-Script Steps

A step can run multiple scripts sequentially under the same user. Use `"scripts"` (array) instead of `"script"` (string):

```json
{
  "id": "prepare-and-post",
  "name": "Prepare and Post PO",
  "user": "purchaser",
  "scripts": [
    "./scripts/create-po.yml",
    "./scripts/post-po.yml"
  ]
}
```

Each script gets its own Playwright report. Failure in any script stops the remaining scripts in that step.

## Notes

- Capture uses BC's native `copy-value` step - the orchestrator reads `copiedValue` from the replay log
- Injection updates the `default:` value in the target script's native `parameters:` section
- No patches required - everything uses BC and bc-replay's built-in capabilities
- Scripts in `scripts/` are real BC recordings that have been tested end-to-end
