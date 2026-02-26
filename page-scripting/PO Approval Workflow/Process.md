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

### 1. Design the workflow (Workflow Builder)

Open [tools/workflow-builder/index.html](../../tools/workflow-builder/index.html) in a browser.

1. Add user roles (`purchaser`, `approver`)
2. Drop your `.yml` scripts into the Script Library
3. Create steps, assign roles and scripts
4. Wire captures and injects using the properties panel
5. Click **Export** and follow the post-export instructions

### 2. Configure users.json

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

### 3. Update workflow.json

If you are not using the Workflow Builder, edit `workflow.json` directly and set `bc_url` to your actual BC URL.

See [workflow.schema.json](workflow.schema.json) for field documentation and VS Code autocomplete support.

### 4. Record your scripts

The `scripts/` folder contains working recordings. To create your own:

1. **Record `create-po.yml`** - Record a Purchase Order creation in BC, ending with a `copy-value` step to capture the PO number
2. **Record `Check PO with approver.yml`** - Record a PO lookup using `Parameters.'Purchase Order List.No.'` to filter by PO number

### 5. Execute the workflow

```powershell
cd bc-replay
.\Run-BCWorkflow.ps1 -WorkflowPath "..\page-scripting\PO Approval Workflow"
```

### 6. View results

```
results/
  workflow-summary.html     # Overall workflow report
  workflow-summary.json     # Machine-readable results
  step-create-po/           # Playwright report for step 1
  step-approve-po/          # Playwright report for step 2
```

---

## BC API Call Steps (`bc-api`)

Alongside the standard `bc-replay` page-scripting steps, a workflow can include direct BC REST API calls authenticated with an Entra ID app registration. This is useful for:

- Seeding test data programmatically (e.g. creating a customer before running a page script)
- Calling custom 4PS BC API endpoints
- Validating data without opening a browser session

### How it works

The runner (`Run-BCWorkflow.ps1`) handles `bc-api` steps separately from `bc-replay` steps:

1. It reads credentials from `app-registrations.json` using the key named in the step
2. It acquires an OAuth 2.0 token via the client credentials flow from Entra ID
3. It resolves placeholder values in the endpoint URL and request body
4. It calls `Invoke-RestMethod` with the resolved endpoint and body
5. It extracts values from the JSON response using JSONPath expressions
6. Those captured values become available to later steps via `{capture.stepId.varName}`

Response bodies are saved to `results/step-<id>/api-response.json` (or `api-error.json` on failure) for inspection.

### Step 1 — Create an Entra ID App Registration

In the [Azure Portal](https://portal.azure.com):

1. Go to **Microsoft Entra ID → App registrations → New registration**
2. Name it (e.g. `BC Workflow Automation`), leave defaults, click **Register**
3. Go to **Authentication → Add a platform → Web** and set the redirect URI to `https://localhost`
   > This flow uses the OAuth 2.0 **client credentials grant** (no user interaction), so a redirect URI is not technically required. However, adding `https://localhost` avoids portal warnings and is a safe placeholder.
4. Note the **Application (client) ID** and **Directory (tenant) ID**
5. Go to **Certificates & secrets → New client secret**, set an expiry, click **Add**
6. Copy the **Value** immediately (it's only shown once)
7. Go to **API permissions → Add a permission → Dynamics 365 Business Central → Application permissions**
   - Add `API.ReadWrite.All`
8. Click **Grant admin consent for [your tenant]**

> See [BC API authentication docs](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-reference/v2.0/enabling-apis-for-dynamics-nav) for more detail.

To find your **Company GUID**, go to Business Central → Settings → My Settings and check the URL, or run a `GET /companies` call — the `id` field in the response is the company GUID.

### Step 2 — Register the app in Business Central

The Entra ID app registration must also be registered inside Business Central so BC knows which permissions to grant it.

1. Open Business Central and search for **Microsoft Entra Applications** (or go to **Setup → Security → Microsoft Entra Applications**)
2. Click **New**
3. Paste the **Application (client) ID** from the Azure Portal into the **Client ID** field
4. Give it a descriptive name (e.g. `BC Workflow Automation`)
5. Set **State** to **Enabled**
6. On the **User Permission Sets** tab, assign the permission sets the app needs (e.g. `D365 BASIC`, `D365 BUS FULL ACCESS`, or a custom set with access to the APIs you call)
7. Click **Grant Consent** — this links the Entra ID app to a BC user context

> Without this step the API calls will return `401 Unauthorized` even if the Entra ID token is valid.

### Step 3 — Configure `app-registrations.json`

Copy `app-registrations.sample.json` to `app-registrations.json` (gitignored) and fill in your values:

```json
{
  "bc-custom-api": {
    "description": "Entra ID app registration for 4PS custom BC API access",
    "client_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "client_secret": "your-secret-value",
    "tenant_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "environment_name": "latestrelease",
    "company_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  }
}
```

You can define multiple named registrations in the same file if different steps need different access levels.

> `app-registrations.json` is gitignored — never commit real credentials.

### Step 4 — Add an API step to `workflow.json`

```json
{
  "id": "create-customer",
  "name": "Create Customer via API",
  "user": "system",
  "type": "bc-api",
  "app_registration": "bc-custom-api",
  "method": "POST",
  "endpoint": "https://4psconstruct.api.bc.dynamics.com/v2.0/{{tenantId}}/{{environmentName}}/api/4ps/custom/v1.0/companies({{companyId}})/customers",
  "body_template": {
    "no": "TESTCUST001",
    "displayName": "Test Customer",
    "city": "Amsterdam"
  },
  "capture_response": {
    "customer_id": "$.id",
    "customer_no": "$.no",
    "customer_systemId": "$.systemId"
  }
}
```

**Endpoint placeholders** — resolved from the referenced app registration entry:

| Placeholder | Source field in `app-registrations.json` |
|---|---|
| `{{tenantId}}` | `tenant_id` |
| `{{environmentName}}` | `environment_name` |
| `{{companyId}}` | `company_id` |

**Capture references** — values captured by earlier steps can be used in the endpoint or body template:

```json
"endpoint": "...customers({capture.create-customer.customer_id})/contacts"
```

**JSONPath expressions** — `capture_response` maps variable names to simple dot-path expressions:

| Expression | Returns |
|---|---|
| `$.id` | Top-level `id` field |
| `$.no` | Top-level `no` field |
| `$.address.city` | Nested `city` field inside `address` |

Captured values are then available to later steps as `{capture.create-customer.customer_id}` etc.

### Step 5 — Run the workflow

API steps require no additional flags — the runner auto-detects `bc-api` steps and loads `app-registrations.json` from the workflow folder:

```powershell
cd bc-replay
.\Run-BCWorkflow.ps1 -WorkflowPath "..\page-scripting\PO Approval Workflow"
```

To load credentials from a different path:

```powershell
.\Run-BCWorkflow.ps1 -WorkflowPath "..." -AppRegistrationsPath "C:\secrets\app-registrations.json"
```

---

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
