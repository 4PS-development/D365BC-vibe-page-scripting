<#
.SYNOPSIS
    Runs multiple BC workflows based on catalog.json hierarchy filtering.

.DESCRIPTION
    Reads catalog.json, resolves matching process flows by composite code filter,
    and executes each matching workflow via Run-BCWorkflow.ps1.
    After all workflows complete, generates an aggregate catalog report.

    Composite codes follow the pattern: VALUE_CHAIN-TYPE-PROCESS_FLOW
    Examples:
      -Filter "PRJ"        → all process flows under value chain Projecten
      -Filter "PRJ-VG"     → all Vastgoed process flows
      -Filter "INK-PO-APPR"→ one specific process flow

.PARAMETER CatalogPath
    Path to catalog.json. Defaults to ..\page-scripting\catalog.json relative to this script.

.PARAMETER Filter
    Composite code prefix to filter which workflows to run.
    Omit to run all process flows in the catalog.

.PARAMETER Headed
    Show the browser window during execution (for debugging).

.PARAMETER StopOnFailure
    Stop the entire catalog run if any workflow fails. Default: $false.

.PARAMETER DryRun
    Preview which workflows would run without executing them.

.EXAMPLE
    .\Run-CatalogWorkflows.ps1 -Filter "PRJ"

.EXAMPLE
    .\Run-CatalogWorkflows.ps1 -Filter "INK-PO" -Headed -DryRun

.EXAMPLE
    .\Run-CatalogWorkflows.ps1
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$CatalogPath,

    [Parameter(Mandatory = $false)]
    [string]$Filter,

    [Parameter(Mandatory = $false)]
    [switch]$Headed = $false,

    [Parameter(Mandatory = $false)]
    [switch]$StopOnFailure = $false,

    [Parameter(Mandatory = $false)]
    [switch]$DryRun = $false
)

$ErrorActionPreference = "Stop"
$scriptRoot = $PSScriptRoot

# ── Resolve catalog path ────────────────────────────────────────────────────
if (-not $CatalogPath) {
    $CatalogPath = Join-Path $scriptRoot "..\page-scripting\catalog.json"
}
if (-not (Test-Path $CatalogPath)) {
    Write-Error "catalog.json not found at: $CatalogPath"
    exit 1
}
$CatalogPath = Resolve-Path $CatalogPath
$pageScriptingRoot = Split-Path $CatalogPath -Parent

# ── Validate catalog first ──────────────────────────────────────────────────
Write-Host ""
Write-Host "Validating catalog..." -ForegroundColor DarkGray
& (Join-Path $scriptRoot "Test-Catalog.ps1") -CatalogPath $CatalogPath
if ($LASTEXITCODE -ne 0) {
    Write-Error "Catalog validation failed. Fix errors before running workflows."
    exit 1
}

# ── Load catalog ────────────────────────────────────────────────────────────
$catalog = Get-Content $CatalogPath -Raw | ConvertFrom-Json

# ── Resolve matching process flows ──────────────────────────────────────────
$matchingFlows = @()

foreach ($vc in $catalog.value_chains) {
    foreach ($type in $vc.types) {
        foreach ($pf in $type.process_flows) {
            $compositeCode = "$($vc.code)-$($type.code)-$($pf.code)"
            $breadcrumb    = "$($vc.name) > $($type.name) > $($pf.name)"

            if ($Filter -and -not $compositeCode.StartsWith($Filter, [System.StringComparison]::OrdinalIgnoreCase)) {
                continue
            }

            $workflowFolder = Join-Path $pageScriptingRoot $pf.workflow_path
            $matchingFlows += [PSCustomObject]@{
                CompositeCode  = $compositeCode
                Breadcrumb     = $breadcrumb
                WorkflowPath   = $workflowFolder
                ValueChain     = $vc.name
                ValueChainCode = $vc.code
                Type           = $type.name
                TypeCode       = $type.code
                ProcessFlow    = $pf.name
                ProcessFlowCode = $pf.code
            }
        }
    }
}

if ($matchingFlows.Count -eq 0) {
    $filterMsg = if ($Filter) { " matching filter '$Filter'" } else { "" }
    Write-Host ""
    Write-Host "  No process flows found$filterMsg." -ForegroundColor Yellow
    exit 0
}

# ── Display plan ────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  BC Catalog Workflow Runner" -ForegroundColor White
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""
if ($Filter) {
    Write-Host "  Filter   : $Filter" -ForegroundColor White
}
Write-Host "  Workflows: $($matchingFlows.Count)" -ForegroundColor White
Write-Host ""

foreach ($flow in $matchingFlows) {
    Write-Host "    [$($flow.CompositeCode)] $($flow.Breadcrumb)" -ForegroundColor DarkGray
}
Write-Host ""

if ($DryRun) {
    Write-Host "  DRY RUN — no workflows will be executed." -ForegroundColor Yellow
    Write-Host ""

    # Still generate catalog report (with no results) for structure preview
    $catalogReportScript = Join-Path $scriptRoot "New-CatalogReport.ps1"
    if (Test-Path $catalogReportScript) {
        & $catalogReportScript -CatalogPath $CatalogPath
    }
    exit 0
}

# ── Execute workflows sequentially ──────────────────────────────────────────
$catalogStart  = Get-Date
$flowResults   = @()

foreach ($flow in $matchingFlows) {
    Write-Host ""
    Write-Host "------------------------------------------------------" -ForegroundColor DarkCyan
    Write-Host "  [$($flow.CompositeCode)] $($flow.ProcessFlow)" -ForegroundColor White
    Write-Host "  $($flow.Breadcrumb)" -ForegroundColor DarkGray
    Write-Host "------------------------------------------------------" -ForegroundColor DarkCyan

    $flowStart = Get-Date
    $runArgs = @{
        WorkflowPath = $flow.WorkflowPath
    }
    if ($Headed) { $runArgs.Headed = $true }
    $runArgs.StopOnFailure = $true

    $exitCode = 0
    try {
        & (Join-Path $scriptRoot "Run-BCWorkflow.ps1") @runArgs
        $exitCode = $LASTEXITCODE
    } catch {
        Write-Warning "  Workflow execution error: $_"
        $exitCode = 1
    }
    $flowEnd = Get-Date

    $status = if ($exitCode -eq 0) { "passed" } else { "failed" }

    $flowResults += [PSCustomObject]@{
        CompositeCode  = $flow.CompositeCode
        Breadcrumb     = $flow.Breadcrumb
        ValueChainCode = $flow.ValueChainCode
        TypeCode       = $flow.TypeCode
        ProcessFlowCode = $flow.ProcessFlowCode
        WorkflowPath   = $flow.WorkflowPath
        Status         = $status
        ExitCode       = $exitCode
        StartTime      = $flowStart
        EndTime        = $flowEnd
        DurationS      = [math]::Round(($flowEnd - $flowStart).TotalSeconds, 1)
    }

    $statusColor = if ($status -eq "passed") { "Green" } else { "Red" }
    Write-Host "  Result: $($status.ToUpper()) ($([math]::Round(($flowEnd - $flowStart).TotalSeconds, 1))s)" -ForegroundColor $statusColor

    if ($StopOnFailure -and $exitCode -ne 0) {
        Write-Host ""
        Write-Host "  Stopping — StopOnFailure is set." -ForegroundColor Red
        break
    }
}

$catalogEnd = Get-Date

# ── Summary ─────────────────────────────────────────────────────────────────
$passed = ($flowResults | Where-Object { $_.Status -eq "passed" }).Count
$failed = ($flowResults | Where-Object { $_.Status -eq "failed" }).Count
$overall = if ($failed -gt 0) { "FAILED" } else { "PASSED" }
$overallColor = if ($overall -eq "PASSED") { "Green" } else { "Red" }

Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  Catalog Run Summary" -ForegroundColor White
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Total    : $($flowResults.Count) process flows" -ForegroundColor White
Write-Host "  Passed   : $passed" -ForegroundColor Green
Write-Host "  Failed   : $failed" -ForegroundColor $(if ($failed -gt 0) { "Red" } else { "White" })
Write-Host "  Duration : $([math]::Round(($catalogEnd - $catalogStart).TotalSeconds, 1))s" -ForegroundColor White
Write-Host "  Overall  : $overall" -ForegroundColor $overallColor
Write-Host ""

# ── Generate aggregate catalog report ────────────────────────────────────────
$catalogReportScript = Join-Path $scriptRoot "New-CatalogReport.ps1"
if (Test-Path $catalogReportScript) {
    & $catalogReportScript -CatalogPath $CatalogPath
}

# Exit with overall result
if ($overall -eq "FAILED") { exit 1 }
