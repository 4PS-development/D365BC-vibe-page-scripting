# Multi-User Workflow Orchestration & Result Capture — Developer Reference

> **This is an internal developer/architecture document.** It contains research notes, approach comparisons, and implementation rationale.
> For a user-friendly guide to creating and running multi-user workflows, see [page-scripting/PO Approval Workflow/Process.md](../page-scripting/PO%20Approval%20Workflow/Process.md) or open the [Workflow Builder](../tools/workflow-builder/index.html).

> **Status:** Complete (tested end-to-end)  
> **Date:** February 2026  
> **Scope:** Evolving from single-user, single-script execution to orchestrated multi-user workflows with state passing between steps

---

## Table of Contents

- [Problem Statement](#problem-statement)
- [Current Architecture](#current-architecture)
- [Target Architecture](#target-architecture)
- [Research Findings](#research-findings)
  - [1. BC Page Scripting Built-in Capabilities](#1-bc-page-scripting-built-in-capabilities)
  - [2. Playwright Capture Capabilities](#2-playwright-capture-capabilities)
  - [3. bc-replay Extensibility (MFA Patch Analysis)](#3-bc-replay-extensibility-mfa-patch-analysis)
  - [4. BC OData Web Services (Demoted)](#4-bc-odata-web-services-demoted)
  - [5. Playwright Reporting & bc-replay Limitations](#5-playwright-reporting--bc-replay-limitations)
  - [6. bc-replay CLI & Version Analysis](#6-bc-replay-cli--version-analysis)
  - [7. Existing Codebase Patterns Inventory](#7-existing-codebase-patterns-inventory)
  - [8. BC Web Client URL Structure](#8-bc-web-client-url-structure)
  - [9. Playwright Reporter API Details](#9-playwright-reporter-api-details)
- [Result Capture Approaches](#result-capture-approaches)
  - [Approach A: BC Page Scripting Native Features (Intra-Script)](#approach-a-bc-page-scripting-native-features-intra-script)
  - [Approach B: Capture Patch + YAML Preprocessing (Cross-Step)](#approach-b-capture-patch--yaml-preprocessing-cross-step)
  - [Demoted: OData API, Tracing, Full Wrapper](#demoted-odata-api-tracing-full-wrapper)
- [Recommendation](#recommendation)
- [Implementation Plan](#implementation-plan)
- [Open Questions](#open-questions)
- [Sources](#sources)

---

## Problem Statement

The current system supports **1 user running 1 set of page scripts**. Real business processes require **multiple users acting in sequence** - for example:

| Step | User | Action | Depends On |
|------|------|--------|------------|
| 1 | Purchaser | Create Purchase Order | - |
| 2 | Approver | Approve PO #12345 | PO number from Step 1 |
| 3 | Warehouse | Receive goods for PO #12345 | Approval in Step 2 |
| 4 | Accountant | Post invoice for PO #12345 | Receipt in Step 3 |

This requires:
- **Multiple user identities** with separate credentials
- **Sequential orchestration** with synchronization between steps
- **State capture** from one step (e.g., "PO number = 12345") to inject into the next
- **Aggregated reporting** across the entire workflow

---

## Current Architecture

```
┌─────────────────────┐     ┌─────────────────┐     ┌────────────────┐
│  PowerShell Runner  │────>│   npx replay    │────>│  BC Web Client │
│  (npx-run.ps1)      │     │  (bc-replay)    │     │  (Playwright)  │
│                     │     │                 │     │                │
│  - 1 set of env     │     │  - CLI only     │     │  - 1 browser   │
│    vars (creds)     │     │  - No API       │     │  - 1 session   │
│  - 1 script path    │     │  - Exit code +  │     │  - 1 user      │
│  - No state capture │     │    HTML report  │     │                │
└─────────────────────┘     └─────────────────┘     └────────────────┘
```

**Limitations:**
- Global env vars = one user identity per execution
- No mechanism to capture output values (document numbers, field values)
- No variable interpolation in YAML scripts (all values hardcoded)
- No inter-script communication or state passing
- Single Playwright report per run

---

## Target Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                   Workflow Orchestrator (PowerShell)           │
│  Reads: workflow.json (steps, users, scripts, dependencies)  │
│  Manages: user credentials, step sequencing, state file      │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Step 1: Create PO           Step 2: Approve PO              │
│  ┌──────────────────┐       ┌──────────────────┐            │
│  │ User: purchaser   │       │ User: approver    │            │
│  │ Script: create.yml│       │ Script: approve.yml│           │
│  │ Capture: PO No.  │──────>│ Inject: PO No.    │            │
│  │ Browser: fresh    │       │ Browser: fresh    │            │
│  └──────────────────┘       └──────────────────┘            │
│          │                           │                       │
│          ▼                           ▼                       │
│  ┌──────────────────┐       ┌──────────────────┐            │
│  │ state.json        │       │ state.json        │            │
│  │ { "po_no":"12345"}│       │ { "approved":true }│           │
│  └──────────────────┘       └──────────────────┘            │
│                                                              │
│  Merged Report: all steps aggregated                         │
└──────────────────────────────────────────────────────────────┘
```

---

## Research Findings

### 1. BC Page Scripting Built-in Capabilities

**Source:** [BC Page Scripting Documentation](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-page-scripting)

The BC page scripting tool has significantly more features than we were using. Key discoveries:

| Feature | Description | Relevance |
|---------|-------------|-----------|
| **Parameters** | Named inputs using `Parameters.'name'` syntax in YAML | Could parameterize scripts instead of hardcoding values |
| **Validate steps** | Assert that a control has a specific value during playback | Verification that steps completed correctly |
| **Clipboard** | Copy field values during recording, reuse within the same session via `Clipboard.'field'` expressions | Intra-script value capture only (session-scoped, does NOT persist across separate bc-replay runs) |
| **Power Fx expressions** | Dynamic values: `Clipboard.'Field' + 1`, `"Customer " & Today()` | Calculated values, dynamic assertions |
| **Include other scripts** | Compose scripts from sub-recordings with parameter passing | Modular test composition |
| **Conditional steps** | Branch execution based on field values or conditions | Handle optional dialogs, conditional flows |
| **Session info** | Access `Session.'User ID'` in expressions | User-aware script logic |
| **Wait steps** | Built-in delay mechanism between steps | Timing control |
| **Optional pages** | Mark pages as optional (may not appear during playback) | Handle confirmation dialogs that may or may not appear |

**How the Clipboard Works:**
- During **recording** in BC's Page Scripting pane: right-click a field > Page Scripting > Copy
- The value is saved and can be pasted into other fields or used in Power Fx expressions
- Referenced as `Clipboard.'Field Caption'` (e.g., `Clipboard.'No.'`)
- **Session-scoped only** - lives within a single recording/playback session
- Cannot pass values between separate `npx replay` invocations
- Useful within a single script, but **not for cross-step state passing** in multi-user workflows

**Critical Question:** It's unclear whether `bc-replay` (the CLI npm player) supports all these features, or only the basic action types (`input`, `invoke`, `focus`, `page-shown`, `page-closed`, `close-page`, `navigate`, `set-current-row`). This needs testing.

### 2. Playwright Capture Capabilities

**Source:** [Playwright Locator API](https://playwright.dev/docs/api/class-locator), [Tracing API](https://playwright.dev/docs/api/class-tracing)

Playwright provides rich capabilities for reading values from the DOM:

| Method | Use Case |
|--------|----------|
| `locator.textContent()` | Read text from any element |
| `locator.inputValue()` | Read current value of input/textarea/select fields |
| `locator.innerHTML()` | Get element's inner HTML |
| `locator.getAttribute('value')` | Read attribute values |
| `page.evaluate(() => ...)` | Run arbitrary JavaScript in the browser context |
| `locator.ariaSnapshot()` | Get YAML representation of the ARIA accessibility tree |
| `locator.screenshot()` | Capture element screenshot |
| `page.locator('[aria-label="No."]')` | Target BC fields by aria-label |
| `page.getByLabel('No.')` | Semantic field targeting |

**Tracing API** allows recording DOM snapshots, screenshots, and network activity per action:
```javascript
await context.tracing.start({ screenshots: true, snapshots: true });
// ... run actions ...
await context.tracing.stop({ path: 'trace.zip' });
```

**Challenge:** All of these require access to the Playwright `page` object, which is internal to bc-replay and not exposed.

### 3. bc-replay Extensibility (MFA Patch Analysis)

**Source:** Analysis of [bc-replay-mfa-solution/](../bc-replay/bc-replay-mfa-solution/SOLUTION.md), [commands.js.patch](../bc-replay/bc-replay-mfa-solution/commands.js.patch), [apply-mfa-patch.ps1](../bc-replay/bc-replay-mfa-solution/apply-mfa-patch.ps1)

Four approaches were tested to extend bc-replay for MFA authentication. Only one worked:

| # | Approach | Result | Details |
|---|----------|--------|-------|
| 1 | Cookie/session transfer from external auth | **Failed** | Attempted pre-authenticating in a separate browser then transferring cookies. BC session management rejected transferred cookies. |
| 2 | Page event handlers (`page.on`) | **Failed** | Tried hooking into page navigation events via Playwright's event system. Race conditions between bc-replay's internal navigation and external event handlers caused unreliable behavior. |
| 3 | Custom Playwright config/fixtures | **Failed** | Created a `playwright.config.ts` with custom fixtures and setup. **bc-replay completely ignores external Playwright configuration files.** This is a fundamental limitation. |
| 4 | **Direct commands.js patching** | **Works** | Modify `node_modules/@microsoft/bc-replay/player/dist/commands.js` to inject code inside the `aadAuthenticate()` function. The only proven extensibility path. |

**How the MFA patch works (detailed):**
1. `apply-mfa-patch.ps1` locates `commands.js` in `node_modules/@microsoft/bc-replay/player/dist/`
2. Checks if already patched (looks for marker string `"MFA TOTP prompt detected"`)
3. Creates a timestamped backup (e.g., `commands.js.backup-20250615-143022`)
4. Applies `commands.js.patch` via string replacement - injects TOTP handling code inside `aadAuthenticate()`
5. The injected code: waits for `input[name="otc"]` with 3s timeout, reads `process.env["BC_MFA_SEED"]`, generates TOTP via `otplib`, fills the OTP field and submits

**For value capture**, the same pattern applies:
1. Identify the step execution function in `commands.js` (requires `npm install` to inspect)
2. Add a hook after step completion that reads field values from the `page` object
3. Write captured values to a JSON file on disk
4. Read the JSON file from the PowerShell orchestrator

**Risk:** Fragile - any bc-replay update could break the patch. Mitigated by: the apply-patch scripts detect if already patched, create backups, and can be re-run after updates.

### 4. BC OData Web Services (Demoted)

**Source:** [BC OData Web Services](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/webservices/odata-web-services)

BC exposes OData v4 endpoints for querying business data:

```
GET https://api.businesscentral.dynamics.com/v2.0/{tenant}/{environment}/api/v2.0/purchaseOrders
    ?$filter=buyFromVendorNumber eq '1000'
    &$orderby=systemCreatedAt desc
    &$top=1
```

**Advantages:**
- Clean separation from UI automation
- No patching of bc-replay required
- Structured JSON responses
- Can query any entity (PO, SO, invoices, etc.)

**Challenges:**
- Requires API permissions on the BC environment
- Need to know what was just created (timing, filter criteria)
- Separate authentication flow needed
- May not capture all intermediate states visible only in the UI

### 5. Playwright Reporting & bc-replay Limitations

**Sources:** [Playwright Reporters](https://playwright.dev/docs/test-reporters) | [Playwright Sharding & Merge](https://playwright.dev/docs/test-sharding) | [Playwright Annotations](https://playwright.dev/docs/test-annotations)

Playwright has a rich reporting ecosystem: HTML, JSON, JUnit, blob, and fully custom reporters via the `Reporter` API. Reports can carry annotations and tags. Blob reports from multiple runs can be merged into a single HTML report.

**However, bc-replay blocks most of this:**
- bc-replay's only reporting flag is `-ResultDir <path>` - no `--reporter`, no format selection
- bc-replay **ignores external `playwright.config.ts`** files (confirmed via MFA solution testing)
- Custom reporters, blob reporter, and annotations all require config access that bc-replay doesn't expose
- Each `npx replay` run produces a standard Playwright HTML report, nothing else

**Env vars worth testing** (may or may not work with bc-replay):
- `PLAYWRIGHT_HTML_TITLE` - could label each step's report with user/step name
- `PLAYWRIGHT_JSON_OUTPUT_NAME` - could produce JSON output alongside HTML

**Conclusion:** Native Playwright report merging is not practical with bc-replay. The recommended approach is an **orchestrator-level summary report** that collects metadata externally and links to individual step reports. See [Step 7: Report Aggregation](#step-7-report-aggregation) for implementation details.

### 6. bc-replay CLI & Version Analysis

**Source:** [@microsoft/bc-replay on npm](https://www.npmjs.com/package/@microsoft/bc-replay)

**Version:** `package.json` pins `@microsoft/bc-replay@^0.1.119` (upgraded from 0.1.76 in Feb 2026). Native TOTP/MFA support was introduced between those versions.

**Full CLI syntax:**
```
npx replay [-Tests] <String> -StartAddress <String>
  [-Authentication Windows|AAD|UserPassword]
  [-UserNameKey <String>] [-PasswordKey <String>]
  [-MultiFactorType None|TOTP|Certificate]
  [-MultiFactorSecretKey <String>]
  [-Headed]
  [-UseServerReplay]
  [-ResultDir <String>]
```

**Key discovery: Native MFA support!**

bc-replay v0.1.119 has built-in MFA parameters:
- `-MultiFactorType TOTP` - specifies TOTP-based MFA
- `-MultiFactorSecretKey <envvar>` - env var name containing the TOTP seed

This could **eliminate the need for the MFA `commands.js` patch entirely**. If native MFA works, the capture patch would be the **only** patch needed, reducing fragility significantly.

| Parameter | Description | Relevance |
|-----------|-------------|----------|
| `-Tests <String>` | Path/glob to YAML script(s) | Multi-script execution |
| `-StartAddress <String>` | BC environment URL | Per-step URL configuration |
| `-Authentication Windows\|AAD\|UserPassword` | Auth method | AAD for Entra ID cloud auth |
| `-UserNameKey <String>` | Env var name for username | Per-user credential switching |
| `-PasswordKey <String>` | Env var name for password | Per-user credential switching |
| `-MultiFactorType None\|TOTP\|Certificate` | MFA method | Native TOTP - replaces old patch approach |
| `-MultiFactorSecretKey <String>` | Env var name for MFA seed | Env var name (not the raw seed value) |
| `-Headed` | Show browser window | Debugging |
| `-UseServerReplay` | Server-side replay mode | Unknown purpose |
| `-ResultDir <String>` | Output directory for results | Per-step report isolation |

**Confirmed (Feb 2026):** `-MultiFactorType TOTP` works. The orchestrator (`Run-BCWorkflow.ps1`) uses it natively — no `commands.js` patch required. The old patch-based MFA approach is deprecated.

### 7. Existing Codebase Patterns Inventory

**Source:** Direct analysis of repository files

The project already has several proven patterns that the multi-user workflow can reuse:

| Pattern | File | What It Does | Reuse For |
|---------|------|-------------|----------|
| **Simple runner** | [npx-run.ps1](../bc-replay/npx-run.ps1) | Prompts for password via `Read-Host -AsSecureString`, sets env vars, calls `npx replay`, shows report | Template for per-step execution |
| **MFA runner** | [npx-run-mfa.ps1](../bc-replay/npx-run-mfa.ps1) | Parameterized runner (`-ScriptsPath`, `-ResultDir`, `-Headed`, `-TestAuthOnly`), validates 4 env vars (BC_USERNAME, BC_PASSWORD, BC_MFA_SEED, BC_URL) | Template for orchestrator with parameterized paths |
| **Automated patching** | [apply-mfa-patch.ps1](../bc-replay/bc-replay-mfa-solution/apply-mfa-patch.ps1) | Finds `commands.js`, checks if already patched (marker string), creates timestamped backup, applies patch via string replacement | Same pattern for capture patch |
| **YAML value substitution** | [Generate-BC-Script-Variants.ps1](../page-scripting/Generate-BC-Script-Variants.ps1) | Reads BASE YAML, does text find-and-replace with data file values, writes variant YAML | YAML preprocessing for state injection |
| **YAML script structure** | [bc-page-script-simple-example.yml](../bc-replay/bc-page-script-simple-example.yml) | 182-line PO creation flow. Action types: `invoke`, `page-shown`, `focus`, `input` (with `isFilterAsYouType`), `page-closed`, `close-page`, `set-current-row`. Target paths: `page > part > page > repeater > field` | Reference for all YAML templates |
| **Project folder convention** | [PO Post DirectionsEMEA/](../page-scripting/PO%20Post%20DirectionsEMEA/) | BASE Recording + data files (Items, Locations) + Process.md + Variants/ | Template for workflow project folders |

**YAML action types observed in the codebase:**

| Action Type | Description | Example Use |
|-------------|-------------|-------------|
| `invoke` | Click a button or action | Post document, open lookup |
| `page-shown` | Wait for a page to appear | Confirm dialog opened |
| `focus` | Set focus on a field | Before inputting a value |
| `input` | Type a value into a field | Vendor No., Item No. |
| `page-closed` | Wait for a page to close | After posting confirms |
| `close-page` | Close the current page | Return to list |
| `navigate` | Navigate to a BC page | Go to Purchase Orders list |
| `set-current-row` | Move to a different row in a repeater | Add new line in PO lines |

### 8. BC Web Client URL Structure

**Source:** [BC Web Client URLs](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-web-client-urls)

BC web client URLs follow a predictable structure useful for the orchestrator's `-StartAddress` parameter:

```
https://businesscentral.dynamics.com/{aadTenantId}/{environmentName}
https://businesscentral.dynamics.com/{aadTenantId}/{environmentName}?page={pageId}
https://businesscentral.dynamics.com/{aadTenantId}/{environmentName}?page={pageId}&filter={table}.{field} IS {value}
https://businesscentral.dynamics.com/{aadTenantId}/{environmentName}?company={companyName}
```

**Useful for multi-user workflows:**
- Deep link directly to a specific page (e.g., PO approval page with filter)
- Switch companies within the same environment
- Pass filter parameters to pre-select a document (e.g., `?page=50&filter=Purchase%20Header.No. IS PO-001234`)
- All scripts in a workflow share the same base URL (tenant/environment), only page parameters differ

**Note:** The `-StartAddress` parameter in `npx replay` sets the initial URL. Most BC page scripts then navigate internally using `invoke` and `navigate` actions, so deep linking via URL is an optimization, not a requirement.

### 9. Playwright Reporter API Details

**Source:** [Playwright Test Reporters](https://playwright.dev/docs/test-reporters), [Playwright Reporter API](https://playwright.dev/docs/api/class-reporter), [Playwright Annotations](https://playwright.dev/docs/test-annotations)

Playwright's reporter system is extensible and feature-rich. While bc-replay blocks direct use (see finding #5), understanding the API informs what's possible if patching is considered.

**Built-in reporter formats:**

| Reporter | Output | Use Case |
|----------|--------|----------|
| `html` | Self-contained HTML folder | Interactive browsing (**bc-replay's default**) |
| `json` | JSON file with full test data | Programmatic analysis |
| `junit` | XML file | CI/CD integration (Azure DevOps, GitHub Actions) |
| `blob` | Zip archive | **Merging multiple runs into one report** |
| `list` | Terminal text | Live watching |
| `dot` | Minimal terminal dots | CI output |
| `github` | GitHub annotations | GitHub Actions integration |

**Custom Reporter API:**

Playwright supports fully custom reporters via a class implementing the `Reporter` interface:

```typescript
import type { Reporter, FullConfig, Suite, TestCase, TestResult, FullResult } from '@playwright/test/reporter';

class MyReporter implements Reporter {
  onBegin(config: FullConfig, suite: Suite) { /* all tests discovered */ }
  onTestBegin(test: TestCase, result: TestResult) { /* test started */ }
  onStepBegin(test: TestCase, result: TestResult, step: TestStep) { /* step started */ }
  onStepEnd(test: TestCase, result: TestResult, step: TestStep) { /* step finished */ }
  onTestEnd(test: TestCase, result: TestResult) { /* test finished */ }
  onEnd(result: FullResult) { /* all tests done, return exit code */ }
  onExit() { /* runner about to exit */ }
}
```

**TestCase objects carry:**
- `test.annotations` - array of `{type, description}` (e.g., `{type: 'user', description: 'purchaser'}`)
- `test.tags` - array of `@tag` strings
- `test.results` - array of `TestResult` with status, duration, errors, attachments
- `test.titlePath()` - full test title hierarchy

**Report merging mechanics:**
```bash
# Step 1: Each run generates a blob report
npx playwright test --reporter=blob --output=./blob-step-1
npx playwright test --reporter=blob --output=./blob-step-2

# Step 2: Merge all blobs into a single HTML report
npx playwright merge-reports --reporter html ./blob-step-*
```

**Why this doesn't work with bc-replay:** The `--reporter=blob` flag would need to be passed through to Playwright's internal config, but `npx replay` doesn't expose a `--reporter` flag and ignores `playwright.config.ts`. Would require a `commands.js` patch to override the reporter configuration internally.

**Practical implication:** The orchestrator-level summary report (see Step 7) is the right approach. If future bc-replay versions expose reporter configuration, native Playwright merging could replace it.

---

## Result Capture Approaches

### Approach A: BC Page Scripting Native Features (Intra-Script)

**Use BC's built-in parameters, validation, clipboard, and script includes within individual scripts.**

The clipboard and parameters are powerful for **within a single script**, but they're session-scoped and can't pass values between separate `npx replay` runs. They simplify individual scripts but don't solve cross-step orchestration.

```yaml
# Example: Script with parameters (needs testing with bc-replay)
name: Create Purchase Order
parameters:
  - name: VendorNo
    type: Text
    defaultValue: "1000"
  - name: ItemNo
    type: Text
    defaultValue: "1896-S"
steps:
  - type: input
    target:
      - page: Purchase Order
        runtimeRef: b385
      - field: Buy-from Vendor No.
    value: Parameters.'VendorNo'    # <-- parameterized!
```

| Pros | Cons |
|------|------|
| Native BC feature, no patching | Unknown if bc-replay supports parameters/validate/includes |
| Power Fx expressions for dynamic values | Clipboard is session-scoped (single bc-replay run only) |
| Script composition via includes | Doesn't solve cross-step state passing |
| Well-documented by Microsoft | Doesn't solve multi-user identity switching |

**Verdict:** Excellent for simplifying individual scripts. **Needs testing** to confirm bc-replay supports these YAML features. Does not solve the multi-user orchestration problem.

### Approach B: Capture Patch + YAML Preprocessing (Cross-Step)

**The primary approach for multi-user workflows. Two simple mechanisms working together:**

**Part 1 - Capture Patch:** Extend the proven `commands.js` patching pattern (same as MFA) to read a field value after a step completes and write it to a JSON file on disk.

```javascript
// Conceptual capture patch in commands.js
// After the final step in a script executes:
const captureConfig = process.env["BC_CAPTURE_FIELDS"];
if (captureConfig) {
    const fields = JSON.parse(captureConfig);
    const captured = {};
    for (const [name, fieldCaption] of Object.entries(fields)) {
        // bc-replay already knows how to target BC fields
        // We just need to READ the value instead of SET it
        const value = await page.locator(`[aria-label="${fieldCaption}"]`)
            .inputValue().catch(() => null);
        captured[name] = value;
    }
    const fs = require('fs');
    fs.writeFileSync(
        process.env["BC_CAPTURE_OUTPUT"] || 'capture.json',
        JSON.stringify(captured, null, 2)
    );
}
```

**Part 2 - YAML Preprocessing:** Before each step, the orchestrator does find-and-replace on the YAML template to inject captured values from the previous step. This is the **exact same pattern** as the existing variant generation (`Generate-BC-Script-Variants.ps1`).

```powershell
# Read captured state from previous step
$state = Get-Content "capture.json" | ConvertFrom-Json

# Inject into next step's YAML template
$yaml = Get-Content "approve-po-template.yml" -Raw
$yaml = $yaml -replace "{{PO_NUMBER}}", $state.po_number
Set-Content -Path "approve-po-ready.yml" -Value $yaml

# Run with different user credentials
npx replay "approve-po-ready.yml" ...
```

| Pros | Cons |
|------|------|
| Proven pattern (same as MFA patch) | Fragile - breaks on bc-replay updates |
| bc-replay already handles BC DOM targeting | Need to identify correct hook point in commands.js |
| YAML preprocessing is same as variant generation | Capture patch needs `npm install` to apply |
| File-based state passing is dead simple | Field aria-labels may differ across BC versions |
| No external APIs or auth flows needed | |

**Verdict:** Simplest path that solves the actual problem. Uses proven patterns from this project.

### Demoted: OData API, Tracing, Full Wrapper

These approaches were researched but are **not recommended** for this use case:

| Approach | Why Demoted |
|----------|-------------|
| **OData API** | Requires Entra ID app registration, OAuth2 token management, API permissions setup. Overkill when we can read the value directly from the page that's already open. Only consider if we need to query data that's NOT visible on the current page. |
| **Playwright Tracing** | Trace files are zip archives containing DOM snapshots. Parsing them to extract a single field value is far more complex than reading it directly. Better suited for debugging. |
| **Full Playwright Wrapper** | Would essentially mean building a custom bc-replay replacement. Massive effort with no clear benefit over the patch approach. |

---

## Recommendation

### Phase 1: Test & Validate (Start Here)

1. **Test bc-replay feature support** - Install bc-replay, create test YAMLs with `parameters:`, `validate`, and `include`. Determine what bc-replay actually supports vs ignores. This single test shapes everything.

2. **Build the capture patch** - Extend the MFA patching pattern to add a capture hook in `commands.js`. Read field values after the last step and write to `capture.json`. Create an `apply-capture-patch.ps1` alongside the existing `apply-mfa-patch.ps1`.

3. **Build the PowerShell orchestrator** - Sequential step execution with different credentials per step. Read `capture.json` from previous step, do find-and-replace on next YAML, run with new user's credentials.

### Phase 2: Polish & Scale

4. **Workflow definition format** - Create `workflow.json` spec that defines steps, users, scripts, dependencies, and capture/inject rules.

5. **Report aggregation** - Combine per-step Playwright reports into a workflow summary.

6. **Sample workflow project** - Create a working 2-3 user PO approval workflow example.

---

## Implementation Plan

### Step 1: Validate bc-replay Feature Support

**Goal:** Determine which YAML features bc-replay actually supports.

- [ ] Install bc-replay and run `npm install`
- [ ] Create test YAML with `parameters:` section
- [ ] Create test YAML with `validate` step
- [ ] Create test YAML with `include` step
- [ ] Document which features work and which are ignored
- [ ] If parameters work, this changes the whole approach significantly

### Step 2: Users Configuration

**Goal:** Define and manage multiple user identities.

Create `users.json`:
```json
{
  "purchaser": {
    "username": "purchaser@tenant.onmicrosoft.com",
    "password": "...",
    "mfa_seed": "...",
    "description": "Creates purchase orders"
  },
  "approver": {
    "username": "approver@tenant.onmicrosoft.com",
    "password": "...",
    "description": "Approves purchase orders"
  }
}
```

### Step 3: Workflow Definition Format

**Goal:** Define the multi-step workflow with dependencies.

Create `workflow.json`:
```json
{
  "name": "Purchase Order Approval Process",
  "bc_url": "https://businesscentral.dynamics.com/{tenant}/{env}",
  "steps": [
    {
      "id": "create-po",
      "name": "Create Purchase Order",
      "user": "purchaser",
      "script": "./scripts/create-po.yml",
      "capture": {
        "po_number": "No.",
        "po_status": "Status"
      }
    },
    {
      "id": "approve-po",
      "name": "Approve Purchase Order",
      "user": "approver",
      "script": "./scripts/approve-po.yml",
      "depends_on": "create-po",
      "inject": {
        "Purchase Order List.No.": "{capture.create-po.po_number}"
      }
    }
  ]
}
```

Steps support either `"script"` (string) for a single recording, or `"scripts"` (array) for multiple recordings that run sequentially under the same user:

```json
{
  "id": "prepare-and-post",
  "name": "Prepare and Post PO",
  "user": "purchaser",
  "scripts": [
    "./scripts/create-po.yml",
    "./scripts/post-po.yml"
  ],
  "capture": { "po_number": "Purchase Order - No." }
}
```

Multi-script steps: each script gets its own result dir and Playwright report. Capture scans all scripts (last value wins). Failure stops remaining scripts in the step.

### Step 4: Capture Patch

**Goal:** Read field values from the page after script execution.

- [ ] Install bc-replay (`npm install`) and inspect `commands.js` structure
- [ ] Identify the step execution function and completion hook point
- [ ] Create `capture.js.patch` that reads fields specified via `BC_CAPTURE_FIELDS` env var
- [ ] Write captured values to `BC_CAPTURE_OUTPUT` path (defaults to `capture.json`)
- [ ] Create `apply-capture-patch.ps1` (same pattern as `apply-mfa-patch.ps1`)
- [ ] Test with a simple PO creation script - capture the PO number

### Step 5: YAML Preprocessor

**Goal:** Inject captured state values into script YAML before execution.

The preprocessor updates the `default:` value in BC's native `parameters:` section:

```powershell
# BC scripts have a parameters section like:
#   parameters:
#     Purchase Order List.No.:
#       type: string
#       default: IO210018
#
# The preprocessor updates the default value to the captured value.
function Invoke-YamlPreprocess {
    param(
        [string]$TemplatePath,
        [string]$OutputPath,
        [hashtable]$Substitutions   # e.g. @{ "Purchase Order List.No." = "PO-001234" }
    )
    # Updates default: values in the parameters: section
    # Falls back to {{PLACEHOLDER}} replacement for hand-crafted templates
}
```

### Step 6: PowerShell Orchestrator

**Goal:** Execute workflow steps in sequence with credential switching and state management.

```powershell
# Pseudocode for Run-BCWorkflow.ps1
function Run-BCWorkflow {
    param([string]$WorkflowPath)
    
    $workflow = Get-Content $WorkflowPath | ConvertFrom-Json
    $state = @{}
    
    foreach ($step in $workflow.steps) {
        Write-Host "Step: $($step.name) [User: $($step.user)]"
        
        # 1. Set credentials for this step's user
        Set-UserCredentials -User $step.user
        
        # 2. Preprocess YAML (inject captured values)
        $processedScript = Invoke-YamlPreprocess `
            -TemplatePath $step.script `
            -Substitutions $step.inject
        
        # 3. Execute bc-replay
        npx replay $processedScript -StartAddress $workflow.bc_url ...
        
        # 4. Read captured state from capture.json
        if ($step.capture) {
            $captured = Get-Content "capture.json" | ConvertFrom-Json
            $state[$step.id] = $captured
        }
        
        # 5. Save state checkpoint
        $state | ConvertTo-Json | Set-Content "workflow-state.json"
    }
}
```

### Step 7: Report Aggregation

**Goal:** Combine results from all workflow steps into a unified workflow report.

**How bc-replay reporting works today:**
- `npx replay` delegates entirely to Playwright's built-in HTML reporter
- Produces a standard Playwright HTML report in `playwright-report/` (or `-ResultDir` path)
- `npx playwright show-report` serves the HTML report
- **No customization exposed** beyond `-ResultDir` - no `--reporter` flag, no format selection
- bc-replay **ignores external `playwright.config.ts`** so Playwright's custom reporters, blob reporter, and annotations can't be injected through normal configuration

**Approach: Orchestrator-Level Summary Report**

The orchestrator already knows everything needed for a workflow report: which user, which step, which script, timing, and exit code. Generate a summary **without modifying bc-replay**:

```
results/
  workflow-summary.html    ← Workflow-level view (users, steps, pass/fail)
  workflow-summary.json    ← Machine-readable for further processing
  step-1-create-po/
    playwright-report/     ← Standard bc-replay report (screenshots, actions)
  step-2-approve-po/
    playwright-report/     ← Standard bc-replay report
  step-3-post-po/
    playwright-report/     ← Standard bc-replay report
```

The summary shows the workflow as a whole (User A created PO > User B approved > User C posted), each step links to its detailed Playwright report for action-level debugging.

**Implementation tasks:**

- [ ] Each step runs with `-ResultDir ./results/step-{id}/`
- [ ] Orchestrator records per-step metadata: step name, user, script, start/end time, duration, exit code, report path
- [ ] After all steps complete, generate `workflow-summary.json` with full workflow results
- [ ] Generate `workflow-summary.html` from the JSON (simple HTML template with pass/fail badges, timing, links)
- [ ] Quick win to test: does `$env:PLAYWRIGHT_HTML_TITLE = "Step 1 - Create PO (User A)"` label each step's report?
- [ ] Quick win to test: does naming scripts like `Step1-Purchaser-CreatePO.yml` improve default report readability?

**Alternatives considered but not recommended:**

| Approach | Why Not |
|----------|---------|
| Patch bc-replay for blob reporter + Playwright merge-reports | Fragile patching, bc-replay ignores Playwright config |
| Patch for custom Playwright reporter with annotations | Same fragility, high effort, annotations require `test.info()` access |
| Merge HTML reports manually | Playwright HTML reports are self-contained bundles, not designed for merging |

### Step 8: Sample Workflow Project

**Goal:** Create a working example with 2-3 users.

Create `page-scripting/PO Approval Workflow/`:
```
PO Approval Workflow/
├── workflow.json
├── users.json
├── scripts/
│   ├── create-po.yml        (purchaser creates PO)
│   ├── approve-po.yml       (approver approves PO)
│   └── receive-goods.yml    (warehouse receives)
├── Process.md
└── results/                  (generated)
```

---

## Open Questions

| # | Question | Impact | How to Resolve |
|---|----------|--------|----------------|
| 1 | Does bc-replay support `parameters:` in YAML? | **YES** - confirmed. BC records native `parameters:` section with `default:` values. Steps use `=Parameters.'Page.Field'`. The preprocessor updates the `default:` value. | Confirmed via real BC recording |
| 2 | Does bc-replay support `validate` steps? | Enables assertions within scripts | Test with installed bc-replay |
| 3 | Does bc-replay support `include` for script composition? | Could simplify multi-step workflows | Test with installed bc-replay |
| 4 | Does `-MultiFactorType TOTP` work natively in bc-replay v0.1.119? | If yes, MFA patch is no longer needed - simplifies everything | Update bc-replay to latest + test MFA flow |
| 5 | What does the `commands.js` step execution function look like? | Determines where to add capture hook | Inspect after `npm install` |
| 6 | What aria-labels does BC use for field elements? | Determines capture selectors | Inspect BC web client DOM in browser DevTools |
| 7 | Can bc-replay and capture patches coexist? | Need both MFA + capture in same commands.js (unless native MFA works) | Test combined patching |
| 8 | Do Playwright env vars work with bc-replay? | `PLAYWRIGHT_HTML_TITLE` could label step reports, `PLAYWRIGHT_JSON_OUTPUT_NAME` could produce JSON output | Test after `npm install` |
| 9 | What changed between bc-replay v0.1.76 and v0.1.119? | Other new features may affect our approach | Check npm changelog or release notes |

---

## Sources

### Official Documentation
- [BC Page Scripting Tool](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-page-scripting) - Parameters, validation, clipboard, includes, Power Fx, conditional steps, session info, wait steps, optional pages
- [BC Web Client URLs](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-web-client-urls) - URL syntax, deep linking, filtering, page parameters, company switching
- [BC OData Web Services](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/webservices/odata-web-services) - REST API for querying BC data (researched but demoted)
- [@microsoft/bc-replay on npm](https://www.npmjs.com/package/@microsoft/bc-replay) - CLI reference, version history, parameter documentation
- [Playwright Locator API](https://playwright.dev/docs/api/class-locator) - DOM value reading methods (`textContent()`, `inputValue()`, `getAttribute()`, `evaluate()`)
- [Playwright Test Reporters](https://playwright.dev/docs/test-reporters) - Built-in and custom reporter formats
- [Playwright Reporter API](https://playwright.dev/docs/api/class-reporter) - Custom reporter class interface
- [Playwright Annotations](https://playwright.dev/docs/test-annotations) - Test metadata, tags, and runtime annotations
- [Playwright Sharding & Merging](https://playwright.dev/docs/test-sharding) - Blob reporter and `merge-reports` CLI for combining runs
- [Playwright Tracing API](https://playwright.dev/docs/api/class-tracing) - DOM snapshot capture (researched but demoted)

### Project References
- [MFA Solution](../bc-replay/bc-replay-mfa-solution/SOLUTION.md) - Documents 4 approaches tested, only commands.js patching works
- [MFA Patch](../bc-replay/bc-replay-mfa-solution/commands.js.patch) - Actual patch code: TOTP handling inside `aadAuthenticate()`
- [Apply Patch Script](../bc-replay/bc-replay-mfa-solution/apply-mfa-patch.ps1) - Automated patch: find commands.js, check marker, backup, apply
- [Variant Generator](../page-scripting/Generate-BC-Script-Variants.ps1) - YAML find-and-replace pattern (reusable for state injection)
- [YAML Example](../bc-replay/bc-page-script-simple-example.yml) - 182-line PO creation script showing all action types and target path structure
- [npx-run.ps1](../bc-replay/npx-run.ps1) - Simple non-MFA runner (Read-Host > env vars > npx replay > show-report)
- [npx-run-mfa.ps1](../bc-replay/npx-run-mfa.ps1) - Parameterized MFA runner (-ScriptsPath, -ResultDir, -Headed, -TestAuthOnly)
- [package.json](../bc-replay/package.json) - Dependencies: bc-replay ^0.1.76, playwright ^1.40.0, otplib ^12.0.1, qrcode ^1.5.3

---

> **Disclaimer:** This project is for demo and research purposes only. Use at your own risk.
