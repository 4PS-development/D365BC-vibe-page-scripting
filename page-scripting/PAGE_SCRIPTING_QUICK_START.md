# Page Scripting Quick Start

A practical guide to recording and replaying Business Central page scripts for automated testing.

## What is Page Scripting?

Page scripting records your interactions with Business Central pages (opening pages, clicking actions, filling fields) and replays them automatically. It's used for **User Acceptance Testing (UAT)** to validate business processes continue working after updates.

**Key concept:** Page scripting captures AL code actions, not generic HTML. It works with BC pages, fields, and actions—not control add-ins or embedded reports.

## Prerequisites

**Permissions:**
- Recording: `PAGESCRIPTING - REC` permission set
- Playback: `PAGESCRIPTING - PLAY` permission set

**For pipeline execution:**
- Node.js 16.14.0+ ([download](https://nodejs.org))
- PowerShell 7+ ([install guide](https://learn.microsoft.com/en-us/powershell/scripting/install/installing-powershell-on-windows))

## Recording Your First Script

### 1. Open Page Scripting Tool
- Navigate to any BC page
- Select **Settings** ⚙️ > **Page Scripting**
- Pane opens on the right side

![BC Page Scripting pane open during a recording](../docs/images/01-bc-page-scripting-pane.png)

### 2. Start Recording
- Click **Start new** or **New recording** 📹
- Button turns red when recording
- Perform your business process step-by-step
- Each action appears as a step in the pane

### 3. Recording Controls
While recording:
- **Pause:** Click Stop ⏹️
- **Resume:** Click Start 🔴
- **Delete step:** Click ⋯ on step > Delete
- **Insert steps:** Click ⋯ > Record from here
- **Rearrange:** Drag steps to reorder

### 4. Stop and Save
- Click **Stop** ⏹️ when finished
- Click **Play** ▶️ to test immediately
- Click **Save** 💾 to download YAML file

## Essential Recording Techniques

### Validate Field Values
Test that fields contain expected values during replay:
1. Right-click a field
2. Select **Page Scripting** > **Validate** > **Current Value**
3. Modify validation rule in step properties if needed

### Add Conditional Steps
Execute steps only when conditions are met:
1. Right-click a control
2. Select **Page Scripting** > **Add conditional steps when**
3. Choose condition (e.g., "Row count is 0")
4. Record conditional actions
5. Click **End scope** when done

### Handle Optional Pages
Prevent failures when pages may not appear:
1. Find "Page X was shown" step
2. Click ⋯ > **Make this an optional page**
3. Following steps become conditional

### Add Wait Times
Insert delays between steps:
1. On the last step, click ⋯ > **Add step** > **Wait**
2. Enter milliseconds to wait
3. Continue recording

## Using Parameters

**Why parameters?** Make scripts reusable by replacing hardcoded values (dates, customer numbers) with variables set at runtime.

### Define Parameter (via UI)
1. Click ⋯ at top of pane > **Properties**
2. Select **Parameters** > **+ Add parameter**
3. Fill in Name, Type, Default value

### Assign Parameter to Step
1. On a step, click ⋯ > **Properties**
2. Enter: `Parameters.[parameter name]`
3. Example: `Parameters.'Sales Order.Document Date'`

### Define Parameter (via YAML)
```yaml
parameters:
  Sales Order.Document Date:
    type: string
    default: 9/4/2025
  Customer No:
    type: string
    default: "10000"
```

Then use in steps:
```yaml
- type: input
  value: =Parameters.'Customer No'
```

## Replaying Scripts

**Three ways to replay:**

1. **Immediately after recording:** Click **Play** ▶️ (before closing pane)
2. **From saved file:** Click **Open** > select YAML > **Play** ▶️
3. **From shared link:** Click link > **Play** ▶️

**Playback controls:**
- ⏮️ **Previous** / ⏭️ **Next** - Navigate steps
- ⏮️⏮️ **Rewind** - Return to start
- ⋯ > **Run to here** - Execute up to selected step

**Results:**
- ✅ Green checkmark = step succeeded
- ❌ Red exclamation = step failed

## Running Scripts in Pipelines (bc-replay)

To execute recorded scripts in automated pipelines outside the BC web client, use the bc-replay npm package.

**Quick example:**
```powershell
# Install and run
npm i @microsoft/bc-replay --save
npx replay .\recordings\*.yml -StartAddress https://your-bc-url -ResultDir .\results
npx playwright show-report .\results\playwright-report
```

📖 **For complete bc-replay setup, authentication options, CI/CD integration, and troubleshooting, see:**
- **`../bc-replay/BC_REPLAY_QUICK_START.md`** - Comprehensive bc-replay guide

## Best Practices

✅ **DO:**
- Start recording from role center or known page
- Create new test entities (customers, orders) during recording
- Filter grids so desired values appear first
- Split complex processes into smaller, reusable recordings
- Use parameters for values that change between runs

❌ **DON'T:**
- Depend on data that may not exist during playback
- Select multiple rows (only last selection is recorded)
- Assume pages/dialogs always appear the same way
- Mix recording with manual edits without testing

## Recording Structure (YAML)

Scripts are saved as YAML files with this structure:

```yaml
name: My Recording
description: Test creating sales order
start:
  profile: ORDER PROCESSOR
parameters:
  Customer No:
    type: string
    default: "10000"
steps:
  - type: open-page
    target: Sales Orders
  - type: input
    target:
      - page: Sales Order
      - field: Sell-to Customer No.
    value: =Parameters.'Customer No'
  - type: invoke-action
    target:
      - page: Sales Order
      - action: Post
```

**Key elements:**
- `name` - Script identifier
- `start.profile` - BC role center to begin from
- `parameters` - Reusable input values
- `steps` - Sequential actions (open-page, input, invoke-action, validate, etc.)

## Including Other Scripts

Reuse recordings by including them in a host script:

**Via UI:**
1. Start recording
2. On a step, click ⋯ > **Add Step** > **Include a script**
3. Browse and select script file
4. Save and test

**Via YAML:**
```yaml
steps:
  - type: include
    name: Setup Customer
    file: ./includes/create-customer.yml
  - type: include
    name: Create Order
    file: ./includes/create-sales-order.yml
```

**Requirements:**
- Included scripts must be accessible from host script location
- Parameters must be defined in both host and included scripts if passing values

## Multi-User Workflows and Native BC Parameters

BC page scripting has a built-in parameter mechanism. When recording scripts, BC generates a `parameters:` section at the end of the YAML with typed parameters and default values. Steps reference parameters using the `=Parameters.'Page.Field'` syntax.

### Native Parameter Syntax

BC recordings that use parameters look like this:

```yaml
steps:
  - type: input
    target:
      - page: Purchase Order List
        runtimeRef: b7yw
      - scope: filter
        field: No.
    value: =Parameters.'Purchase Order List.No.'
    description: Input <value>Parameters.'Purchase Order List.No.'</value> into <caption>No.</caption>

# At the end of the file:
parameters:
  Purchase Order List.No.:
    type: string
    default: IO210018
```

The workflow orchestrator (`Run-BCWorkflow.ps1`) updates the `default:` value with values captured from a previous step before running the script.

### When to Use Parameters

- A field value depends on what was created in a previous step (e.g., document numbers)
- Different users act on the same document in sequence
- You want the same recording to work across different test runs

### Workflow Project Structure

```
PO Approval Workflow/
  workflow.json                  # Step definitions, capture/inject rules
  users.json                     # User roles with credentials
  scripts/
    create-po.yml                # Step 1: Record in BC (captures PO number)
    Check PO with approver.yml   # Step 2: Uses Parameters.'Purchase Order List.No.'
  Process.md                     # Business process documentation
```

See [PO Approval Workflow](PO%20Approval%20Workflow/) for a complete example and [MULTI-USER-WORKFLOW-PLAN.md](../docs/MULTI-USER-WORKFLOW-PLAN.md) for architecture details.

## Resources

**Official Documentation:**
- [Page Scripting Overview](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-page-scripting)
- [Power Fx Expressions](https://learn.microsoft.com/en-us/power-platform/power-fx/overview)
- [BC Replay npm Package](https://www.npmjs.com/package/@microsoft/bc-replay)

**This Repository:**
- `../README.md` - Complete project documentation
- `../GETTING_STARTED.md` - Repository quick start
- `../bc-replay/BC_REPLAY_QUICK_START.md` - Pipeline execution guide
- `../docs/MULTI-USER-WORKFLOW-PLAN.md` - Multi-user workflow architecture
- `../.github/copilot-instructions.md` - YAML patterns and conventions

---

**Next Steps:**
1. Record a simple process (e.g., create customer)
2. Test replay immediately
3. Save and share with team
4. Build variant suite using project automation scripts
5. Try multi-user workflows with `Run-BCWorkflow.ps1`
