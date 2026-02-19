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
    $overallBg    = if ($summary.overall -eq "PASSED") { "#22c55e" } else { "#D0021B" }

    $stepsHtml = ""
    foreach ($r in $StepResults) {
        $badgeColor = switch ($r.status) {
            "passed"  { "#22c55e" }
            "failed"  { "#D0021B" }
            "skipped" { "#eab308" }
            "dry-run" { "#6b7280" }
            default   { "#6b7280" }
        }

        $reportLink = ""
        # Playwright writes reports to playwright-report/ subdirectory inside the step folder
        if ($r.report_dir -and (Test-Path (Join-Path $r.report_dir "playwright-report/index.html") -ErrorAction SilentlyContinue)) {
            $relPath = "step-$($r.id)/playwright-report/index.html"
            $reportLink = "<a href=`"$relPath`" style=`"color:#D0021B;font-weight:600`">View Report</a>"
        } else {
            $reportLink = "<span style=`"color:#999`">No report</span>"
        }

        $stepsHtml += @"
        <tr>
            <td>$($r.id)</td>
            <td><strong>$($r.name)</strong></td>
            <td>$($r.user)</td>
            <td>
                <span class="badge" style="background:$badgeColor">$($r.status.ToUpper())</span>
            </td>
            <td>$($r.duration_s)s</td>
            <td>$reportLink</td>
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
        * { box-sizing: border-box; }
        body {
            font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
            margin: 0; padding: 0;
            background: #F5F5F5; color: #444444;
        }
        .header-bar {
            background: #1A1A1A;
            padding: 16px 32px;
            display: flex; align-items: center; gap: 16px;
        }
        .header-bar img { height: 40px; }
        .header-bar .header-title {
            color: #fff; font-size: 1.1em; font-weight: 600; letter-spacing: 0.02em;
        }
        .container { max-width: 960px; margin: 0 auto; padding: 28px 24px; }
        h1 { margin: 0 0 4px 0; font-size: 1.5em; color: #1A1A1A; }
        .subtitle { color: #666; margin-bottom: 24px; font-size: 0.95em; }
        .summary-bar { display: flex; gap: 16px; margin-bottom: 28px; }
        .summary-card {
            background: #fff; border: 1px solid #e0e0e0; border-radius: 8px;
            padding: 14px 20px; flex: 1; text-align: center;
            box-shadow: 0 1px 3px rgba(0,0,0,0.06);
        }
        .summary-card .label { font-size: 0.8em; color: #888; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
        .summary-card .value { font-size: 1.5em; font-weight: 700; color: #333; }
        table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
        th {
            background: #333333; color: #fff;
            text-align: left; padding: 11px 14px;
            font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600;
        }
        td { padding: 10px 14px; font-size: 0.92em; }
        tr:not(:last-child) td { border-bottom: 1px solid #f0f0f0; }
        tbody tr:hover { background: #fafafa; }
        .badge {
            color: #fff; padding: 3px 10px; border-radius: 4px;
            font-size: 0.82em; font-weight: 600; display: inline-block;
        }
        .overall-badge {
            color: #fff; padding: 3px 12px; border-radius: 4px;
            font-weight: 700; font-size: 0.9em; display: inline-block;
        }
        .red-accent { border-left: 4px solid #D0021B; }
        .footer {
            margin-top: 28px; padding-top: 16px; border-top: 1px solid #e0e0e0;
            font-size: 0.78em; color: #999; display: flex; justify-content: space-between; align-items: center;
        }
        a { text-decoration: none; }
        a:hover { text-decoration: underline; }
    </style>
</head>
<body>
<div class="header-bar">
    <img src="https://www.4ps.nl/wp-content/uploads/sites/2/4PS_Endorsement-2024_RGB_stacked.png" alt="4PS" />
    <span class="header-title">BC Workflow Report</span>
</div>
<div class="container">
    <h1>$([System.Web.HttpUtility]::HtmlEncode($WorkflowName))</h1>
    <p class="subtitle">
        <span class="overall-badge" style="background:$overallBg">$($summary.overall)</span>
        &nbsp; $($WorkflowStart.ToString("yyyy-MM-dd HH:mm:ss")) &mdash; $([math]::Round(($WorkflowEnd - $WorkflowStart).TotalSeconds, 1))s total
    </p>

    <div class="summary-bar">
        <div class="summary-card"><div class="label">Steps</div><div class="value">$($StepResults.Count)</div></div>
        <div class="summary-card"><div class="label">Passed</div><div class="value" style="color:#22c55e">$($summary.passed)</div></div>
        <div class="summary-card"><div class="label">Failed</div><div class="value" style="color:#D0021B">$($summary.failed)</div></div>
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

    <div class="footer">
        <span>Generated by BC Multi-User Workflow Orchestrator</span>
        <span style="color:#D0021B; font-weight:600">4PS</span>
    </div>
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
