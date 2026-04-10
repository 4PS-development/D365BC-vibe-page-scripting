<#
.SYNOPSIS
    Generates an aggregate dashboard report from catalog.json and all workflow results.

.DESCRIPTION
    Reads catalog.json and scans each process flow's results/workflow-summary.json
    to produce a unified HTML + JSON report showing the 3-level hierarchy
    (Waardeketen > Type > Procesflow) with pass/fail status per entry.

.PARAMETER CatalogPath
    Path to catalog.json. Defaults to ..\page-scripting\catalog.json relative to this script.

.PARAMETER OutputDir
    Output directory for the report. Defaults to the catalog.json parent folder.

.EXAMPLE
    .\New-CatalogReport.ps1
    .\New-CatalogReport.ps1 -CatalogPath "..\page-scripting\catalog.json"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$CatalogPath,

    [Parameter(Mandatory = $false)]
    [string]$OutputDir
)

$ErrorActionPreference = "Stop"

# ── Resolve paths ───────────────────────────────────────────────────────────
if (-not $CatalogPath) {
    $CatalogPath = Join-Path $PSScriptRoot "..\page-scripting\catalog.json"
}
if (-not (Test-Path $CatalogPath)) {
    Write-Error "catalog.json not found at: $CatalogPath"
    exit 1
}
$CatalogPath = Resolve-Path $CatalogPath
$pageScriptingRoot = Split-Path $CatalogPath -Parent

if (-not $OutputDir) {
    $OutputDir = $pageScriptingRoot
}

# ── Load catalog ────────────────────────────────────────────────────────────
$catalog = Get-Content $CatalogPath -Raw | ConvertFrom-Json

# ── Collect results ─────────────────────────────────────────────────────────
$reportData = @{
    generated_at   = (Get-Date).ToString("o")
    value_chains   = @()
    totals         = @{ process_flows = 0; passed = 0; failed = 0; not_run = 0 }
}

foreach ($vc in $catalog.value_chains) {
    $vcData = @{
        code           = $vc.code
        name           = $vc.name
        description    = $vc.description
        types          = @()
        totals         = @{ process_flows = 0; passed = 0; failed = 0; not_run = 0 }
    }

    foreach ($type in $vc.types) {
        $typeData = @{
            code           = $type.code
            name           = $type.name
            composite_code = "$($vc.code)-$($type.code)"
            description    = $type.description
            process_flows  = @()
            totals         = @{ process_flows = 0; passed = 0; failed = 0; not_run = 0 }
        }

        foreach ($pf in $type.process_flows) {
            $compositeCode = "$($vc.code)-$($type.code)-$($pf.code)"
            $workflowFolder = Join-Path $pageScriptingRoot $pf.workflow_path
            $summaryPath = Join-Path $workflowFolder "results\workflow-summary.json"

            $pfData = @{
                code           = $pf.code
                name           = $pf.name
                composite_code = $compositeCode
                breadcrumb     = "$($vc.name) > $($type.name) > $($pf.name)"
                workflow_path  = $pf.workflow_path
                status         = "not_run"
                overall        = $null
                total_steps    = 0
                passed_steps   = 0
                failed_steps   = 0
                duration_s     = $null
                last_run       = $null
                report_path    = $null
            }

            if (Test-Path $summaryPath) {
                try {
                    $summary = Get-Content $summaryPath -Raw | ConvertFrom-Json
                    $pfData.status       = $summary.overall.ToLower()
                    $pfData.overall      = $summary.overall
                    $pfData.total_steps  = $summary.total_steps
                    $pfData.passed_steps = $summary.passed
                    $pfData.failed_steps = $summary.failed
                    $pfData.duration_s   = $summary.duration_s
                    $pfData.last_run     = $summary.start_time
                    $pfData.report_path  = Join-Path $pf.workflow_path "results\workflow-summary.html"
                } catch {
                    Write-Warning "  Could not read summary for $compositeCode : $_"
                }
            }

            $typeData.process_flows += $pfData
            $typeData.totals.process_flows++

            switch ($pfData.status) {
                "passed"  { $typeData.totals.passed++ }
                "failed"  { $typeData.totals.failed++ }
                default   { $typeData.totals.not_run++ }
            }
        }

        $vcData.types += $typeData
        $vcData.totals.process_flows += $typeData.totals.process_flows
        $vcData.totals.passed        += $typeData.totals.passed
        $vcData.totals.failed        += $typeData.totals.failed
        $vcData.totals.not_run       += $typeData.totals.not_run
    }

    $reportData.value_chains += $vcData
    $reportData.totals.process_flows += $vcData.totals.process_flows
    $reportData.totals.passed        += $vcData.totals.passed
    $reportData.totals.failed        += $vcData.totals.failed
    $reportData.totals.not_run       += $vcData.totals.not_run
}

# ── Write JSON report ───────────────────────────────────────────────────────
$jsonPath = Join-Path $OutputDir "catalog-report.json"
$reportData | ConvertTo-Json -Depth 10 | Set-Content -Path $jsonPath
Write-Host "  JSON report: $jsonPath" -ForegroundColor DarkGray

# ── Build HTML report ───────────────────────────────────────────────────────
function Get-StatusBadge {
    param([string]$Status)
    $color = switch ($Status) {
        "passed"  { "#22c55e" }
        "failed"  { "#D0021B" }
        default   { "#6b7280" }
    }
    $label = switch ($Status) {
        "passed"  { "PASSED" }
        "failed"  { "FAILED" }
        default   { "NOT RUN" }
    }
    return "<span style=`"display:inline-block;padding:2px 10px;border-radius:4px;color:#fff;font-size:12px;font-weight:600;background:$color`">$label</span>"
}

function Get-TotalsBadges {
    param([hashtable]$Totals)
    $parts = @()
    if ($Totals.passed -gt 0)  { $parts += "<span style=`"color:#22c55e;font-weight:600`">$($Totals.passed) passed</span>" }
    if ($Totals.failed -gt 0)  { $parts += "<span style=`"color:#D0021B;font-weight:600`">$($Totals.failed) failed</span>" }
    if ($Totals.not_run -gt 0) { $parts += "<span style=`"color:#6b7280`">$($Totals.not_run) not run</span>" }
    return ($parts -join " &middot; ")
}

$totalsPF     = $reportData.totals
$overallColor = if ($totalsPF.failed -gt 0) { "#D0021B" } elseif ($totalsPF.not_run -eq $totalsPF.process_flows) { "#6b7280" } else { "#22c55e" }

$vcSections = ""
foreach ($vc in $reportData.value_chains) {
    $typeSections = ""
    foreach ($type in $vc.types) {
        $pfRows = ""
        foreach ($pf in $type.process_flows) {
            $durationCell = if ($pf.duration_s) { "$($pf.duration_s)s" } else { "-" }
            $lastRunCell  = if ($pf.last_run) {
                try { ([datetime]$pf.last_run).ToString("yyyy-MM-dd HH:mm") } catch { $pf.last_run }
            } else { "-" }
            $reportLink = if ($pf.report_path) {
                "<a href=`"$($pf.report_path)`" style=`"color:#3b82f6;text-decoration:none`">View Report</a>"
            } else { "" }

            $pfRows += @"
            <tr>
                <td style="padding:8px 12px;font-family:monospace;font-size:13px;color:#64748b">$($pf.composite_code)</td>
                <td style="padding:8px 12px;font-weight:500">$($pf.name)</td>
                <td style="padding:8px 12px;text-align:center">$(Get-StatusBadge $pf.status)</td>
                <td style="padding:8px 12px;text-align:center;color:#64748b">$($pf.total_steps) steps</td>
                <td style="padding:8px 12px;text-align:right;color:#64748b;font-family:monospace">$durationCell</td>
                <td style="padding:8px 12px;text-align:center;color:#64748b;font-size:12px">$lastRunCell</td>
                <td style="padding:8px 12px;text-align:center">$reportLink</td>
            </tr>
"@
        }

        $typeSections += @"
        <div style="margin-bottom:16px">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
                <h3 style="margin:0;font-size:16px;color:#334155">$($type.composite_code) &mdash; $($type.name)</h3>
                <span style="font-size:13px;color:#64748b">$(Get-TotalsBadges $type.totals)</span>
            </div>
            $(if ($type.description) { "<p style=`"margin:0 0 8px 0;font-size:13px;color:#64748b`">$($type.description)</p>" })
            <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden">
                <thead>
                    <tr style="background:#f8fafc">
                        <th style="padding:8px 12px;text-align:left;font-size:12px;color:#64748b;font-weight:600">Code</th>
                        <th style="padding:8px 12px;text-align:left;font-size:12px;color:#64748b;font-weight:600">Process Flow</th>
                        <th style="padding:8px 12px;text-align:center;font-size:12px;color:#64748b;font-weight:600">Status</th>
                        <th style="padding:8px 12px;text-align:center;font-size:12px;color:#64748b;font-weight:600">Steps</th>
                        <th style="padding:8px 12px;text-align:right;font-size:12px;color:#64748b;font-weight:600">Duration</th>
                        <th style="padding:8px 12px;text-align:center;font-size:12px;color:#64748b;font-weight:600">Last Run</th>
                        <th style="padding:8px 12px;text-align:center;font-size:12px;color:#64748b;font-weight:600">Report</th>
                    </tr>
                </thead>
                <tbody>
$pfRows
                </tbody>
            </table>
        </div>
"@
    }

    $vcSections += @"
    <section style="margin-bottom:32px;padding:20px;background:#fff;border:1px solid #e2e8f0;border-radius:8px">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
            <h2 style="margin:0;font-size:20px;color:#1e293b">$($vc.code) &mdash; $($vc.name)</h2>
            <span style="font-size:13px">$(Get-TotalsBadges $vc.totals)</span>
        </div>
        $(if ($vc.description) { "<p style=`"margin:0 0 16px 0;font-size:14px;color:#64748b`">$($vc.description)</p>" })
$typeSections
    </section>
"@
}

$html = @"
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Test Catalog Report</title>
    <style>
        * { box-sizing: border-box; }
        body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: #f1f5f9; color: #1e293b; }
        .header { background: #1A1A1A; color: #fff; padding: 24px 32px; }
        .header h1 { margin: 0 0 8px 0; font-size: 24px; font-weight: 600; }
        .header .subtitle { color: #94a3b8; font-size: 14px; }
        .summary { display: flex; gap: 16px; padding: 20px 32px; background: #fff; border-bottom: 1px solid #e2e8f0; }
        .summary .card { flex: 1; padding: 16px; border-radius: 8px; border: 1px solid #e2e8f0; text-align: center; }
        .summary .card .value { font-size: 28px; font-weight: 700; }
        .summary .card .label { font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 4px; }
        .content { padding: 24px 32px; max-width: 1200px; }
        table { font-size: 14px; }
        tbody tr:nth-child(even) { background: #f8fafc; }
        tbody tr:hover { background: #f1f5f9; }
        a:hover { text-decoration: underline !important; }
    </style>
</head>
<body>
    <div class="header">
        <h1>Test Catalog Report</h1>
        <div class="subtitle">Generated: $((Get-Date).ToString("yyyy-MM-dd HH:mm:ss")) &mdash; Waardeketen &gt; Type &gt; Procesflow</div>
    </div>

    <div class="summary">
        <div class="card">
            <div class="value" style="color:$overallColor">$($totalsPF.process_flows)</div>
            <div class="label">Process Flows</div>
        </div>
        <div class="card">
            <div class="value" style="color:#22c55e">$($totalsPF.passed)</div>
            <div class="label">Passed</div>
        </div>
        <div class="card">
            <div class="value" style="color:#D0021B">$($totalsPF.failed)</div>
            <div class="label">Failed</div>
        </div>
        <div class="card">
            <div class="value" style="color:#6b7280">$($totalsPF.not_run)</div>
            <div class="label">Not Run</div>
        </div>
    </div>

    <div class="content">
$vcSections
    </div>
</body>
</html>
"@

$htmlPath = Join-Path $OutputDir "catalog-report.html"
$html | Set-Content -Path $htmlPath -Encoding utf8
Write-Host "  HTML report: $htmlPath" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Catalog report generated." -ForegroundColor Green
