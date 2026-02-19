<#
.SYNOPSIS
    Generates a workflow summary report (HTML + JSON) from step results.

.DESCRIPTION
    After a multi-user workflow completes, this function creates:
    - workflow-summary.json: Machine-readable results for CI/CD or further processing
    - workflow-summary.html: Human-readable report with pass/fail badges and links to
      individual step Playwright reports

    Each step's detailed report (screenshots, actions) remains in its own subfolder
    as a standard Playwright HTML report. The summary links them together.

.PARAMETER WorkflowName
    Display name of the workflow.

.PARAMETER StepResults
    Array of step result objects from Run-BCWorkflow.ps1.

.PARAMETER OutputDir
    Directory where summary files will be written.

.PARAMETER WorkflowStart
    Workflow start timestamp.

.PARAMETER WorkflowEnd
    Workflow end timestamp.
#>

function New-WorkflowReport {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$WorkflowName,

        [Parameter(Mandatory = $true)]
        [array]$StepResults,

        [Parameter(Mandatory = $true)]
        [string]$OutputDir,

        [Parameter(Mandatory = $true)]
        [datetime]$WorkflowStart,

        [Parameter(Mandatory = $true)]
        [datetime]$WorkflowEnd
    )

    if (-not (Test-Path $OutputDir)) {
        New-Item -Path $OutputDir -ItemType Directory -Force | Out-Null
    }

    # ── Build JSON summary ──────────────────────────────────────────────────
    $summary = [ordered]@{
        workflow_name = $WorkflowName
        start_time    = $WorkflowStart.ToString("o")
        end_time      = $WorkflowEnd.ToString("o")
        duration_s    = [math]::Round(($WorkflowEnd - $WorkflowStart).TotalSeconds, 1)
        total_steps   = $StepResults.Count
        passed        = ($StepResults | Where-Object { $_.status -eq "passed" }).Count
        failed        = ($StepResults | Where-Object { $_.status -eq "failed" }).Count
        skipped       = ($StepResults | Where-Object { $_.status -eq "skipped" }).Count
        overall       = if (($StepResults | Where-Object { $_.status -eq "failed" }).Count -gt 0) { "FAILED" } else { "PASSED" }
        steps         = @()
    }

    foreach ($r in $StepResults) {
        $summary.steps += [ordered]@{
            id         = $r.id
            name       = $r.name
            user       = $r.user
            status     = $r.status
            exit_code  = $r.exit_code
            start_time = $r.start_time.ToString("o")
            end_time   = $r.end_time.ToString("o")
            duration_s = $r.duration_s
            report_dir = if ($r.report_dir) { (Resolve-Path $r.report_dir -ErrorAction SilentlyContinue)?.Path ?? $r.report_dir } else { $null }
        }
    }

    $jsonPath = Join-Path $OutputDir "workflow-summary.json"
    $summary | ConvertTo-Json -Depth 10 | Set-Content -Path $jsonPath
    Write-Verbose "JSON summary: $jsonPath"

    # ── Build HTML summary ──────────────────────────────────────────────────
    $overallColor = if ($summary.overall -eq "PASSED") { "#22c55e" } else { "#ef4444" }

    $stepsHtml = ""
    foreach ($r in $StepResults) {
        $badgeColor = switch ($r.status) {
            "passed"  { "#22c55e" }
            "failed"  { "#ef4444" }
            "skipped" { "#eab308" }
            "dry-run" { "#6b7280" }
            default   { "#6b7280" }
        }

        $reportLink = ""
        if ($r.report_dir -and (Test-Path (Join-Path $r.report_dir "index.html") -ErrorAction SilentlyContinue)) {
            $relPath = "step-$($r.id)/index.html"
            $reportLink = "<a href=`"$relPath`" style=`"color:#3b82f6`">View Report</a>"
        } else {
            $reportLink = "<span style=`"color:#9ca3af`">No report</span>"
        }

        $stepsHtml += @"
        <tr>
            <td style="padding:8px 12px">$($r.id)</td>
            <td style="padding:8px 12px"><strong>$($r.name)</strong></td>
            <td style="padding:8px 12px">$($r.user)</td>
            <td style="padding:8px 12px">
                <span style="background:$badgeColor;color:#fff;padding:2px 8px;border-radius:4px;font-size:0.85em">$($r.status.ToUpper())</span>
            </td>
            <td style="padding:8px 12px">$($r.duration_s)s</td>
            <td style="padding:8px 12px">$reportLink</td>
        </tr>
"@
    }

    $html = @"
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Workflow Report - $([System.Web.HttpUtility]::HtmlEncode($WorkflowName))</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 24px; background: #f9fafb; color: #1f2937; }
        .container { max-width: 900px; margin: 0 auto; }
        h1 { margin: 0 0 4px 0; font-size: 1.5em; }
        .subtitle { color: #6b7280; margin-bottom: 20px; }
        .summary-bar { display: flex; gap: 16px; margin-bottom: 24px; }
        .summary-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 20px; flex: 1; text-align: center; }
        .summary-card .label { font-size: 0.85em; color: #6b7280; }
        .summary-card .value { font-size: 1.4em; font-weight: 700; }
        table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
        th { background: #f3f4f6; text-align: left; padding: 10px 12px; font-size: 0.85em; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; }
        tr:not(:last-child) td { border-bottom: 1px solid #f3f4f6; }
        .footer { margin-top: 20px; font-size: 0.8em; color: #9ca3af; }
    </style>
</head>
<body>
<div class="container">
    <h1>$([System.Web.HttpUtility]::HtmlEncode($WorkflowName))</h1>
    <p class="subtitle">
        <span style="background:$overallColor;color:#fff;padding:2px 10px;border-radius:4px;font-weight:600">$($summary.overall)</span>
        &nbsp; $($WorkflowStart.ToString("yyyy-MM-dd HH:mm:ss")) &mdash; $([math]::Round(($WorkflowEnd - $WorkflowStart).TotalSeconds, 1))s total
    </p>

    <div class="summary-bar">
        <div class="summary-card"><div class="label">Steps</div><div class="value">$($StepResults.Count)</div></div>
        <div class="summary-card"><div class="label">Passed</div><div class="value" style="color:#22c55e">$($summary.passed)</div></div>
        <div class="summary-card"><div class="label">Failed</div><div class="value" style="color:#ef4444">$($summary.failed)</div></div>
        <div class="summary-card"><div class="label">Skipped</div><div class="value" style="color:#eab308">$($summary.skipped)</div></div>
    </div>

    <table>
        <thead>
            <tr>
                <th>Step</th>
                <th>Name</th>
                <th>User</th>
                <th>Status</th>
                <th>Duration</th>
                <th>Details</th>
            </tr>
        </thead>
        <tbody>
$stepsHtml
        </tbody>
    </table>

    <p class="footer">Generated by BC Multi-User Workflow Orchestrator</p>
</div>
</body>
</html>
"@

    $htmlPath = Join-Path $OutputDir "workflow-summary.html"
    Set-Content -Path $htmlPath -Value $html
    Write-Verbose "HTML summary: $htmlPath"

    Write-Host "  Reports generated:" -ForegroundColor Cyan
    Write-Host "    JSON: $jsonPath" -ForegroundColor Gray
    Write-Host "    HTML: $htmlPath" -ForegroundColor Gray
}
