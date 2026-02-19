# BC-Replay Capture Solution

> **Status: Superseded** - This patch approach is no longer needed. BC's native `copy-value` step type captures field values during script execution, and the orchestrator reads them directly from the replay log.

## What Replaced This

BC Page Scripting has a built-in `copy-value` step type that:
1. Captures a field value during script execution
2. Writes it to the replay log YAML as `copiedValue`
3. The orchestrator (`Run-BCWorkflow.ps1`) parses the replay log to extract captured values

### How it works now

**In the recording** (added via BC's Page Scripting tool):
```yaml
- type: copy-value
  name: Purchase Order - No.
  valueType: string
  description: Copy value from <caption>No.</caption>
```

**In the replay log** (written by bc-replay during execution):
```yaml
- type: copy-value
  name: Purchase Order - No.
  log:
    copiedValue: IO210022
```

**In workflow.json** (tells orchestrator what to capture):
```json
{
  "capture": {
    "po_number": "Purchase Order - No."
  }
}
```

The orchestrator matches the `name` from `workflow.json` against replay log entries and extracts the `copiedValue`.

## Legacy Files

The files in this directory (`apply-capture-patch.ps1`) were scaffolding for a Playwright-based capture patch that was never needed. They are kept for reference only.
