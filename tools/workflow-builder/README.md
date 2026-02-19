# BC Workflow Builder

Visual tool for building `workflow.json` and `users.sample.json` files without editing JSON by hand.

## What it does

Functional users record `.yml` page scripts in Business Central. This tool lets them **wire those scripts together** into a multi-user workflow visually:

- Define user roles (purchaser, approver, etc.)
- Load recorded `.yml` scripts via drag-and-drop
- Build workflow steps as a connected flow
- Auto-detect **captures** (`copy-value` steps) and **parameters** (injectable values) from scripts
- Export ready-to-use `workflow.json` + `users.sample.json`

## How to use

1. **Open** `index.html` in any browser (double-click or use VS Code's Simple Browser)
2. **Set** workflow name, description, and BC environment URL in the left panel
3. **Add user roles** (e.g. purchaser, approver) - these are the actors in your workflow
4. **Drop your `.yml` scripts** onto the Script Library area - the tool parses them automatically
5. **Add steps** and for each step:
   - Pick a user role
   - Assign a script (dropdown or drag onto the step card)
   - Captures and injects are auto-suggested from the script content
6. **Export** - downloads `workflow.json` and `users.sample.json` to your Downloads folder
7. **Move** the exported files into your workflow project folder

## Smart features

| Feature | How it works |
|---------|-------------|
| Auto-detect captures | Parses `copy-value` steps in your `.yml` and suggests capture variables |
| Auto-detect parameters | Finds the `parameters:` section and shows what values the script expects |
| Auto-map injects | Matches parameters to available captures from earlier steps |
| Dependency tracking | Steps auto-link to the previous step; adjust via the properties panel |
| Validation | Checks for missing roles, scripts, duplicate IDs before export |
| Import existing | Load an existing `workflow.json` to edit it visually |

## Import an existing workflow

Click **Import** in the header and select your `workflow.json` (and optionally `users.sample.json`). The builder reconstructs the visual flow from the JSON.

## Output

The tool generates two files matching the format expected by `Run-BCWorkflow.ps1`:

**workflow.json** - steps, dependencies, capture/inject rules:
```json
{
  "name": "Purchase Order Approval",
  "bc_url": "https://businesscentral.dynamics.com/...",
  "steps": [
    { "id": "create-po", "user": "purchaser", "script": "./scripts/create-po.yml", "capture": {...} },
    { "id": "approve-po", "user": "approver", "script": "./scripts/check-po.yml", "depends_on": "create-po", "inject": {...} }
  ]
}
```

**users.sample.json** - role template with placeholder credentials:
```json
{
  "purchaser": { "username": "purchaser@yourtenant.onmicrosoft.com", "password": "your-password-here" },
  "approver": { "username": "approver@yourtenant.onmicrosoft.com", "password": "your-password-here" }
}
```

Copy `users.sample.json` to `users.json` and fill in real credentials (never commit `users.json`).
