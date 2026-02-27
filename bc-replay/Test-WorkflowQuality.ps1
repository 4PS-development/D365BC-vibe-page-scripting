<#
.SYNOPSIS
    Evaluates a BC page scripting workflow for testing best practices.

.DESCRIPTION
    Performs static analysis of YAML test scripts and workflow configuration
    to produce a quality scorecard with actionable recommendations:
      - Pass A: Per-script static YAML analysis (missing validations, orphaned params, etc.)
      - Pass B: Workflow-level analysis (capture-inject chain, dependency integrity, record continuity)
      - Pass C: Best-practice recommendations with quality grades

    Outputs an HTML report and JSON summary.

.PARAMETER WorkflowPath
    Path to the project folder containing workflow.json.

.PARAMETER OutputPath
    Optional. Directory for the evaluation report. Defaults to <WorkflowPath>/results.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$WorkflowPath,

    [string]$OutputPath
)

# ── Helpers ────────────────────────────────────────────────────────────────────
$ErrorActionPreference = 'Stop'

function Write-Status($msg)   { Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Finding($sev, $msg) {
    switch ($sev) {
        'error'   { Write-Host "    ERROR   $msg" -ForegroundColor Red }
        'warning' { Write-Host "    WARN    $msg" -ForegroundColor Yellow }
        'info'    { Write-Host "    INFO    $msg" -ForegroundColor DarkGray }
    }
}

# ── Validate inputs ───────────────────────────────────────────────────────────
if (-not (Test-Path $WorkflowPath)) {
    Write-Error "WorkflowPath not found: $WorkflowPath"
    exit 1
}

$wfFile = Join-Path $WorkflowPath "workflow.json"
if (-not (Test-Path $wfFile)) {
    Write-Error "workflow.json not found in: $WorkflowPath"
    exit 1
}

if (-not $OutputPath) { $OutputPath = Join-Path $WorkflowPath "results" }
if (-not (Test-Path $OutputPath)) { New-Item -Path $OutputPath -ItemType Directory -Force | Out-Null }

# ── Load workflow ──────────────────────────────────────────────────────────────
$workflow = Get-Content $wfFile -Raw | ConvertFrom-Json
Write-Host ""
Write-Host "  4PS Workflow Quality Evaluator" -ForegroundColor White
Write-Host "  Workflow: $($workflow.name)" -ForegroundColor White
Write-Host "  Project:  $WorkflowPath" -ForegroundColor DarkGray
Write-Host ""

# ── Data structures ────────────────────────────────────────────────────────────
$findings = [System.Collections.ArrayList]::new()

function Add-Finding {
    param([string]$Severity, [string]$Category, [string]$StepId, [string]$Script,
          [int]$Line, [string]$Message, [string]$Recommendation)
    [void]$findings.Add([PSCustomObject]@{
        severity       = $Severity
        category       = $Category
        step_id        = $StepId
        script         = $Script
        line           = $Line
        message        = $Message
        recommendation = $Recommendation
    })
}

# ══════════════════════════════════════════════════════════════════════════════
# PASS A — Per-script static YAML analysis
# ══════════════════════════════════════════════════════════════════════════════
Write-Status "Pass A: Static YAML script analysis"

# Collect all scripts referenced in the workflow
$scriptFiles = @{}
foreach ($step in $workflow.steps) {
    if ($step.type -eq 'bc-api') { continue }
    $scripts = @()
    if ($step.script)  { $scripts += $step.script }
    if ($step.scripts) { $scripts += $step.scripts }
    foreach ($s in $scripts) {
        $resolved = if ([System.IO.Path]::IsPathRooted($s)) { $s }
                    else { Join-Path $WorkflowPath $s }
        if (Test-Path $resolved) {
            $scriptFiles[$resolved] = $step.id
        } else {
            Add-Finding 'error' 'file' $step.id $s 0 "Script file not found: $s" "Ensure the script path is correct and the file exists."
        }
    }
}

# Analyse each YAML script
$scriptAnalysis = @{}
foreach ($scriptPath in $scriptFiles.Keys) {
    $stepId = $scriptFiles[$scriptPath]
    $scriptName = [System.IO.Path]::GetFileName($scriptPath)
    Write-Status "  Analysing: $scriptName"

    try {
        $yamlContent = Get-Content $scriptPath -Raw
        # Simple line-based YAML parsing (no external dependency needed)
        $lines = Get-Content $scriptPath

        # Parse steps into structured objects using regex
        $steps = [System.Collections.ArrayList]::new()
        $currentStep = $null
        $lineNum = 0
        $inParameters = $false
        $parameterNames = @{}
        $parameterRefs = @{}

        foreach ($line in $lines) {
            $lineNum++

            # Detect parameters section
            if ($line -match '^parameters:') {
                $inParameters = $true
                continue
            }

            if ($inParameters) {
                # Parameter name (indented key with colon)
                if ($line -match '^\s{2}(\S[^:]+):') {
                    $parameterNames[$matches[1].Trim()] = $lineNum
                }
                continue
            }

            # Detect step boundaries (- type: xxx)
            if ($line -match '^\s{2}- type:\s*(.+)') {
                if ($currentStep) { [void]$steps.Add($currentStep) }
                $currentStep = @{
                    type      = $matches[1].Trim()
                    line      = $lineNum
                    fields    = @{}
                    target    = @()
                    value     = $null
                    name      = $null
                    operation = $null
                    isRepeater = $false
                }
                continue
            }

            if ($currentStep) {
                # Capture field references from target
                if ($line -match '^\s+- field:\s*(.+)') {
                    $currentStep.fields['field'] = $matches[1].Trim()
                }
                if ($line -match '^\s+- repeater:\s*') {
                    $currentStep.isRepeater = $true
                }
                if ($line -match '^\s+value:\s*(.+)') {
                    $val = $matches[1].Trim()
                    $currentStep.value = $val
                    # Track parameter references
                    if ($val -match "Parameters\.'([^']+)'") {
                        $parameterRefs[$matches[1]] = $lineNum
                    }
                }
                if ($line -match '^\s+name:\s*(.+)') {
                    $currentStep.name = $matches[1].Trim()
                }
                if ($line -match '^\s+operation:\s*(.+)') {
                    $currentStep.operation = $matches[1].Trim()
                }
                if ($line -match '^\s+invokeType:\s*(.+)') {
                    $currentStep.fields['invokeType'] = $matches[1].Trim()
                }
            }
        }
        if ($currentStep) { [void]$steps.Add($currentStep) }

        # ── Analysis metrics ──────────────────────────────────────────────────

        $inputSteps     = $steps | Where-Object { $_.type -eq 'input' }
        $validateSteps  = $steps | Where-Object { $_.type -eq 'validate' }
        $copySteps      = $steps | Where-Object { $_.type -eq 'copy-value' }
        $invokeSteps    = $steps | Where-Object { $_.type -eq 'invoke' }
        $pageShownSteps = $steps | Where-Object { $_.type -eq 'page-shown' }
        $navigateSteps  = $steps | Where-Object { $_.type -eq 'navigate' }
        $focusSteps     = $steps | Where-Object { $_.type -eq 'focus' }

        $analysis = @{
            script          = $scriptName
            total_steps     = $steps.Count
            input_count     = @($inputSteps).Count
            validate_count  = @($validateSteps).Count
            copy_count      = @($copySteps).Count
            invoke_count    = @($invokeSteps).Count
            navigate_count  = @($navigateSteps).Count
            has_parameters  = $parameterNames.Count -gt 0
        }
        $scriptAnalysis[$scriptPath] = $analysis

        # CHECK 1: No validate steps at all
        if (@($validateSteps).Count -eq 0) {
            Add-Finding 'warning' 'validation' $stepId $scriptName 0 `
                "Script has zero validate steps — no assertions verify expected outcomes." `
                "Add validate steps after key actions (e.g., after entering data, after navigation) to confirm the expected result. Right-click a control during recording and select Page Scripting > Validate > Current Value."
        }

        # CHECK 2: Input steps without matching validate
        $validatedFields = @{}
        foreach ($v in $validateSteps) {
            if ($v.fields['field']) { $validatedFields[$v.fields['field']] = $true }
        }

        $criticalFields = @('No.', 'Status', 'Document Type', 'Buy-from Vendor No.', 'Buy-from Vendor Name',
                            'Sell-to Customer No.', 'Sell-to Customer Name', 'Line Amount', 'Amount',
                            'Total Amount', 'Quantity', 'Direct Unit Cost', 'Unit Price')

        foreach ($inp in $inputSteps) {
            $field = $inp.fields['field']
            if (-not $field) { continue }
            # Skip filter inputs (scope: filter)
            if ($yamlContent.Substring(0, [Math]::Min($yamlContent.Length, ($inp.line * 200))) -match 'scope:\s*filter') { continue }

            if (-not $validatedFields.ContainsKey($field) -and $field -in $criticalFields) {
                Add-Finding 'info' 'validation' $stepId $scriptName $inp.line `
                    "Input to critical field '$field' (line $($inp.line)) has no matching validate step." `
                    "Consider adding a validate step for '$field' to assert the value was accepted by BC."
            }
        }

        # CHECK 3: Navigate/invoke without subsequent page-shown
        for ($i = 0; $i -lt $steps.Count; $i++) {
            $s = $steps[$i]
            if ($s.type -eq 'navigate') {
                $hasPageShown = $false
                for ($j = $i + 1; $j -lt [Math]::Min($i + 4, $steps.Count); $j++) {
                    if ($steps[$j].type -eq 'page-shown') { $hasPageShown = $true; break }
                }
                if (-not $hasPageShown) {
                    Add-Finding 'warning' 'navigation' $stepId $scriptName $s.line `
                        "Navigate action (line $($s.line)) is not followed by a page-shown assertion." `
                        "Add a page-shown step after navigate to confirm the expected page loaded."
                }
            }
        }

        # CHECK 4: Unused parameters (declared but never referenced)
        foreach ($pName in $parameterNames.Keys) {
            if (-not $parameterRefs.ContainsKey($pName)) {
                Add-Finding 'warning' 'parameters' $stepId $scriptName $parameterNames[$pName] `
                    "Parameter '$pName' is declared (line $($parameterNames[$pName])) but never referenced in any value expression." `
                    "Remove unused parameters or add value references using =Parameters.'$pName' syntax."
            }
        }

        # CHECK 5: Hardcoded values when parameters section exists
        if ($parameterNames.Count -gt 0) {
            foreach ($inp in $inputSteps) {
                $val = $inp.value
                if (-not $val) { continue }
                if ($val -match '^=') { continue } # Already uses expression
                if ($val -match '^\d+$' -and [int]$val -le 10) { continue } # Small numbers (e.g., Type=1) are OK
                $field = $inp.fields['field']
                if (-not $field) { continue }
                # Check if this field has a parameter defined
                $matchingParam = $parameterNames.Keys | Where-Object { $_ -like "*$field*" -or $_ -like "*$($field.Replace(' ', ''))*" }
                if (-not $matchingParam -and $field -in $criticalFields) {
                    Add-Finding 'info' 'parameters' $stepId $scriptName $inp.line `
                        "Field '$field' (line $($inp.line)) uses hardcoded value '$val' — consider parameterizing for reuse." `
                        "Add a parameter for this field in the parameters section and reference it with =Parameters.'PageName.$field'."
                }
            }
        }

        # CHECK 6: copy-value without a meaningful name
        foreach ($cv in $copySteps) {
            if (-not $cv.name -or $cv.name.Trim() -eq '') {
                Add-Finding 'warning' 'capture' $stepId $scriptName $cv.line `
                    "copy-value step (line $($cv.line)) has no name — captured value cannot be referenced by the workflow." `
                    "Add a descriptive name field (e.g., 'Purchase Order - No.') so the workflow can reference this capture."
            }
        }

        # CHECK 7: Focus before input on repeater fields
        foreach ($inp in $inputSteps) {
            if (-not $inp.isRepeater) { continue }
            $field = $inp.fields['field']
            if (-not $field) { continue }
            $idx = $steps.IndexOf($inp)
            if ($idx -le 0) { continue }
            $prevStep = $steps[$idx - 1]
            $hasPriorFocus = ($prevStep.type -eq 'focus' -and $prevStep.fields['field'] -eq $field)
            if (-not $hasPriorFocus) {
                # Not always required but is a best practice for repeater fields
                Add-Finding 'info' 'structure' $stepId $scriptName $inp.line `
                    "Input on repeater field '$field' (line $($inp.line)) is not preceded by a focus step on the same field." `
                    "Add a focus step before input on repeater fields to ensure the correct cell is targeted."
            }
        }

    } catch {
        Add-Finding 'error' 'parse' $stepId $scriptName 0 `
            "Failed to parse YAML script: $_" `
            "Ensure the YAML file is valid and was generated by BC's page scripting recorder."
    }
}

# ══════════════════════════════════════════════════════════════════════════════
# PASS B — Workflow-level analysis
# ══════════════════════════════════════════════════════════════════════════════
Write-Status "Pass B: Workflow-level analysis"

# Build capture registry: which steps define which captures
$captureRegistry = @{}
foreach ($step in $workflow.steps) {
    $stepCaptures = @()
    if ($step.capture) {
        foreach ($prop in $step.capture.PSObject.Properties) {
            $stepCaptures += $prop.Name
        }
    }
    if ($step.capture_response) {
        foreach ($prop in $step.capture_response.PSObject.Properties) {
            $stepCaptures += $prop.Name
        }
    }
    if ($stepCaptures.Count -gt 0) {
        $captureRegistry[$step.id] = $stepCaptures
    }
}

# Build inject registry: which steps consume which captures
$injectRegistry = @{}
foreach ($step in $workflow.steps) {
    if (-not $step.inject) { continue }
    $stepInjects = @()
    foreach ($prop in $step.inject.PSObject.Properties) {
        $expr = $prop.Value
        if ($expr -match '\{capture\.([^.]+)\.([^}]+)\}') {
            $stepInjects += @{
                field     = $prop.Name
                sourceStep = $matches[1]
                sourceVar  = $matches[2]
                raw       = $expr
            }
        }
    }
    if ($stepInjects.Count -gt 0) {
        $injectRegistry[$step.id] = $stepInjects
    }
}

# CHECK B1: Inject references resolve to actual captures
foreach ($stepId in $injectRegistry.Keys) {
    foreach ($inj in $injectRegistry[$stepId]) {
        $srcStep = $inj.sourceStep
        $srcVar  = $inj.sourceVar
        if (-not $captureRegistry.ContainsKey($srcStep)) {
            Add-Finding 'error' 'chain' $stepId '' 0 `
                "Inject references capture from step '$srcStep' which defines no captures." `
                "Add a capture block to step '$srcStep' or fix the inject expression: $($inj.raw)"
        } elseif ($srcVar -notin $captureRegistry[$srcStep]) {
            Add-Finding 'error' 'chain' $stepId '' 0 `
                "Inject references variable '$srcVar' from step '$srcStep', but that step only captures: $($captureRegistry[$srcStep] -join ', ')." `
                "Fix the inject expression or add '$srcVar' to step '$srcStep' capture block."
        }
    }
}

# CHECK B2: Missing depends_on for steps that inject
foreach ($step in $workflow.steps) {
    if (-not $step.inject) { continue }
    foreach ($prop in $step.inject.PSObject.Properties) {
        if ($prop.Value -match '\{capture\.([^.]+)\.') {
            $srcStep = $matches[1]
            $hasDep = $false
            if ($step.depends_on) {
                $deps = if ($step.depends_on -is [array]) { $step.depends_on } else { @($step.depends_on) }
                $hasDep = $srcStep -in $deps
            }
            if (-not $hasDep) {
                Add-Finding 'warning' 'dependency' $step.id '' 0 `
                    "Step '$($step.id)' injects from '$srcStep' but does not declare depends_on for it." `
                    "Add `"depends_on`": `"$srcStep`" to ensure the source step completes before this step runs."
            }
        }
    }
}

# CHECK B3: Orphaned captures (defined but never consumed)
$allConsumedCaptures = @{}
foreach ($stepId in $injectRegistry.Keys) {
    foreach ($inj in $injectRegistry[$stepId]) {
        $key = "$($inj.sourceStep).$($inj.sourceVar)"
        $allConsumedCaptures[$key] = $true
    }
}

foreach ($stepId in $captureRegistry.Keys) {
    foreach ($capName in $captureRegistry[$stepId]) {
        $key = "$stepId.$capName"
        if (-not $allConsumedCaptures.ContainsKey($key)) {
            Add-Finding 'info' 'chain' $stepId '' 0 `
                "Capture '$capName' in step '$stepId' is never consumed by any downstream step inject." `
                "If this capture is intentional (e.g., for logging), this is fine. Otherwise, consider using it in a downstream step to verify the captured value."
        }
    }
}

# CHECK B4: Record continuity — when a step injects a value, does its script validate it loaded the right record?
foreach ($stepId in $injectRegistry.Keys) {
    $step = $workflow.steps | Where-Object { $_.id -eq $stepId }
    if (-not $step -or $step.type -eq 'bc-api') { continue }

    # Find the script for this step
    $scriptRef = if ($step.script) { $step.script } elseif ($step.scripts) { $step.scripts[0] } else { $null }
    if (-not $scriptRef) { continue }

    $resolved = if ([System.IO.Path]::IsPathRooted($scriptRef)) { $scriptRef }
                else { Join-Path $WorkflowPath $scriptRef }

    if (-not (Test-Path $resolved)) { continue }

    $yamlContent = Get-Content $resolved -Raw
    $hasValidate = $yamlContent -match 'type:\s*validate'

    if (-not $hasValidate) {
        $injectedFields = ($injectRegistry[$stepId] | ForEach-Object { $_.field }) -join ', '
        Add-Finding 'warning' 'continuity' $stepId ([System.IO.Path]::GetFileName($resolved)) 0 `
            "Step '$stepId' receives injected values ($injectedFields) but its script contains no validate steps to confirm the correct record was loaded." `
            "Add a validate step in the script to assert the injected value matches (e.g., validate that the PO number displayed matches the injected PO number). This ensures each step operates on the expected record."
    }
}

# CHECK B5: Multi-user handoff — recommend validation when user changes
$prevUser = $null
foreach ($step in $workflow.steps) {
    if ($step.user -and $prevUser -and $step.user -ne $prevUser -and $step.type -ne 'bc-api') {
        $hasInject = $null -ne $step.inject
        if (-not $hasInject) {
            Add-Finding 'info' 'handoff' $step.id '' 0 `
                "User switches from '$prevUser' to '$($step.user)' at step '$($step.id)' with no injected parameters." `
                "When switching users, consider injecting a reference (e.g., document number) from the previous step and validating it to ensure the correct record is loaded."
        }
    }
    if ($step.user) { $prevUser = $step.user }
}

# CHECK B6: Steps with no script or scripts defined (bc-replay steps)
foreach ($step in $workflow.steps) {
    if ($step.type -eq 'bc-api') { continue }
    if (-not $step.script -and -not $step.scripts) {
        Add-Finding 'error' 'structure' $step.id '' 0 `
            "Step '$($step.id)' is a bc-replay step but has no script or scripts defined." `
            "Assign a YAML script to this step."
    }
}

# ══════════════════════════════════════════════════════════════════════════════
# PASS C — Compute scorecard and generate report
# ══════════════════════════════════════════════════════════════════════════════
Write-Status "Pass C: Computing quality scorecard"

$totalInputs     = ($scriptAnalysis.Values | Measure-Object -Property input_count -Sum).Sum
$totalValidates  = ($scriptAnalysis.Values | Measure-Object -Property validate_count -Sum).Sum
$totalCopies     = ($scriptAnalysis.Values | Measure-Object -Property copy_count -Sum).Sum
$totalScripts    = $scriptAnalysis.Count
$scriptsWithVal  = ($scriptAnalysis.Values | Where-Object { $_.validate_count -gt 0 }).Count

# Scores (0-100)
$validationRatio  = if ($totalInputs -gt 0) { [math]::Min(100, [math]::Round(($totalValidates / $totalInputs) * 100, 0)) } else { 100 }

# Count total captures (YAML copy-value + API capture_response)
$totalCapturesDefined = 0
foreach ($stepId in $captureRegistry.Keys) { $totalCapturesDefined += $captureRegistry[$stepId].Count }
$totalCapturesConsumed = ($allConsumedCaptures.Keys).Count
$captureUsage = if ($totalCapturesDefined -gt 0) {
    [math]::Min(100, [math]::Round(($totalCapturesConsumed / $totalCapturesDefined) * 100, 0))
} else { 100 }

$scriptCoverage   = if ($totalScripts -gt 0) { [math]::Min(100, [math]::Round(($scriptsWithVal / $totalScripts) * 100, 0)) } else { 100 }
$chainIntegrity   = 100
$errorFindings = $findings | Where-Object { $_.severity -eq 'error' -and $_.category -eq 'chain' }
if (@($errorFindings).Count -gt 0) { $chainIntegrity = 0 }

# Weighted overall score
$overallScore = [math]::Round(
    ($validationRatio * 0.35) +
    ($scriptCoverage  * 0.25) +
    ($captureUsage    * 0.20) +
    ($chainIntegrity  * 0.20)
, 0)

$grade = if ($overallScore -ge 90) { 'A' }
    elseif ($overallScore -ge 75) { 'B' }
    elseif ($overallScore -ge 60) { 'C' }
    elseif ($overallScore -ge 40) { 'D' }
    else { 'F' }

$gradeColor = switch ($grade) {
    'A' { '#1a7a3f'; break }
    'B' { '#2e7d32'; break }
    'C' { '#f57c00'; break }
    'D' { '#e65100'; break }
    'F' { '#c0392b'; break }
}

$errorCount   = @($findings | Where-Object { $_.severity -eq 'error' }).Count
$warningCount = @($findings | Where-Object { $_.severity -eq 'warning' }).Count
$infoCount    = @($findings | Where-Object { $_.severity -eq 'info' }).Count

Write-Host ""
Write-Host "  Quality Grade: $grade ($overallScore/100)" -ForegroundColor $(if ($overallScore -ge 75) { 'Green' } elseif ($overallScore -ge 50) { 'Yellow' } else { 'Red' })
Write-Host "  Errors: $errorCount | Warnings: $warningCount | Suggestions: $infoCount" -ForegroundColor White
Write-Host ""

# ── Write findings to console ─────────────────────────────────────────────────
foreach ($f in $findings) { Write-Finding $f.severity "$($f.step_id): $($f.message)" }

# ══════════════════════════════════════════════════════════════════════════════
# Generate JSON summary
# ══════════════════════════════════════════════════════════════════════════════

$jsonSummary = [ordered]@{
    workflow_name      = $workflow.name
    evaluation_time    = (Get-Date).ToString("o")
    overall_score      = $overallScore
    grade              = $grade
    scores             = [ordered]@{
        validation_ratio = $validationRatio
        script_coverage  = $scriptCoverage
        capture_usage    = $captureUsage
        chain_integrity  = $chainIntegrity
    }
    counts             = [ordered]@{
        errors   = $errorCount
        warnings = $warningCount
        info     = $infoCount
        total    = $findings.Count
    }
    scripts_analysed   = $scriptAnalysis.Values | ForEach-Object {
        [ordered]@{
            script         = $_.script
            total_steps    = $_.total_steps
            input_count    = $_.input_count
            validate_count = $_.validate_count
            copy_count     = $_.copy_count
        }
    }
    findings           = $findings | ForEach-Object {
        [ordered]@{
            severity       = $_.severity
            category       = $_.category
            step_id        = $_.step_id
            script         = $_.script
            line           = $_.line
            message        = $_.message
            recommendation = $_.recommendation
        }
    }
}

$jsonPath = Join-Path $OutputPath "evaluation-report.json"
$jsonSummary | ConvertTo-Json -Depth 10 | Set-Content -Path $jsonPath
Write-Status "JSON report: $jsonPath"

# ══════════════════════════════════════════════════════════════════════════════
# Generate HTML report
# ══════════════════════════════════════════════════════════════════════════════

$sevIcon = @{ error = '&#x274C;'; warning = '&#x26A0;&#xFE0F;'; info = '&#x1F4A1;' }
$sevLabel = @{ error = 'Error'; warning = 'Warning'; info = 'Suggestion' }
$sevColor = @{ error = '#c0392b'; warning = '#b35a00'; info = '#1565c0' }
$sevBg    = @{ error = '#fde8e8'; warning = '#fff3e0'; info = '#e3f2fd' }

$catLabel = @{
    validation = 'Missing Validation'
    navigation = 'Navigation Check'
    parameters = 'Parameter Usage'
    capture    = 'Value Capture'
    chain      = 'Capture-Inject Chain'
    dependency = 'Step Dependency'
    continuity = 'Record Continuity'
    handoff    = 'User Handoff'
    structure  = 'Script Structure'
    file       = 'File Error'
    parse      = 'Parse Error'
}

# Parameter flow table data
$flowRows = ""
foreach ($step in $workflow.steps) {
    $captures = ""
    $injects  = ""
    if ($captureRegistry.ContainsKey($step.id)) {
        $captures = ($captureRegistry[$step.id] | ForEach-Object {
            $consumed = $allConsumedCaptures.ContainsKey("$($step.id).$_")
            $cls = if ($consumed) { 'flow-ok' } else { 'flow-orphan' }
            "<span class='flow-tag $cls'>$([System.Web.HttpUtility]::HtmlEncode($_))</span>"
        }) -join ' '
    }
    if ($injectRegistry.ContainsKey($step.id)) {
        $injects = ($injectRegistry[$step.id] | ForEach-Object {
            $valid = $captureRegistry.ContainsKey($_.sourceStep) -and $_.sourceVar -in $captureRegistry[$_.sourceStep]
            $cls = if ($valid) { 'flow-ok' } else { 'flow-broken' }
            "<span class='flow-tag $cls'>$([System.Web.HttpUtility]::HtmlEncode($_.sourceStep)).$([System.Web.HttpUtility]::HtmlEncode($_.sourceVar))</span>"
        }) -join ' '
    }
    $user = if ($step.user) { [System.Web.HttpUtility]::HtmlEncode($step.user) } else { '—' }
    $stepType = if ($step.type -eq 'bc-api') { '<span class="badge badge-api">API</span>' } else { '<span class="badge badge-replay">Replay</span>' }
    $flowRows += "<tr><td><strong>$([System.Web.HttpUtility]::HtmlEncode($step.id))</strong></td><td>$stepType</td><td>$user</td><td>$(if($captures){''}else{'<span class=''text-muted''>none</span>'})$captures</td><td>$(if($injects){''}else{'<span class=''text-muted''>none</span>'})$injects</td></tr>`n"
}

# Findings rows grouped by step
$findingsHtml = ""
$grouped = $findings | Group-Object step_id
foreach ($group in $grouped) {
    $stepLabel = if ($group.Name) { $group.Name } else { 'Workflow-level' }
    foreach ($f in $group.Group) {
        $ico = $sevIcon[$f.severity]
        $bg  = $sevBg[$f.severity]
        $col = $sevColor[$f.severity]
        $cat = if ($catLabel.ContainsKey($f.category)) { $catLabel[$f.category] } else { $f.category }
        $scriptRef = if ($f.script) { "<span class='finding-script'>$([System.Web.HttpUtility]::HtmlEncode($f.script))$(if($f.line -gt 0){ " line $($f.line)" })</span>" } else { '' }
        $findingsHtml += @"
<div class="finding" style="border-left: 3px solid $col; background: $bg;">
  <div class="finding-header">
    <span class="finding-icon">$ico</span>
    <span class="finding-sev" style="color:$col;">$($sevLabel[$f.severity])</span>
    <span class="finding-cat">$cat</span>
    <span class="finding-step">Step: $([System.Web.HttpUtility]::HtmlEncode($stepLabel))</span>
    $scriptRef
  </div>
  <div class="finding-msg">$([System.Web.HttpUtility]::HtmlEncode($f.message))</div>
  <div class="finding-rec">$([System.Web.HttpUtility]::HtmlEncode($f.recommendation))</div>
</div>

"@
    }
}

# Script analysis table
$scriptRows = ""
foreach ($sa in $scriptAnalysis.Values) {
    $valClass = if ($sa.validate_count -eq 0) { 'text-error' } elseif ($sa.validate_count -lt $sa.input_count) { 'text-warn' } else { 'text-ok' }
    $scriptFindings = @($findings | Where-Object { $_.script -eq $sa.script }).Count
    $scriptRows += "<tr><td>$([System.Web.HttpUtility]::HtmlEncode($sa.script))</td><td>$($sa.total_steps)</td><td>$($sa.input_count)</td><td class='$valClass'>$($sa.validate_count)</td><td>$($sa.copy_count)</td><td>$scriptFindings</td></tr>`n"
}

$html = @"
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Workflow Quality Report — $([System.Web.HttpUtility]::HtmlEncode($workflow.name))</title>
<style>
  :root { --primary:#D0021B; --success:#1a7a3f; --warning:#b35a00; --error:#c0392b; --border:#e0e0e0; --surface:#fff; --surface-2:#f5f5f5; --text:#1a1a1a; --text-muted:#666; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; color: var(--text); background: var(--surface-2); padding: 24px; }
  .container { max-width: 1100px; margin: 0 auto; }
  .header { display: flex; align-items: center; gap: 20px; margin-bottom: 24px; padding: 20px; background: #1a1a1a; color: #fff; border-radius: 8px; }
  .header-grade { width: 72px; height: 72px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 32px; font-weight: 700; color: #fff; flex-shrink: 0; }
  .header-info h1 { font-size: 20px; margin-bottom: 4px; }
  .header-info p  { font-size: 12px; color: #aaa; }
  .score-label { font-size: 11px; color: #aaa; margin-top: 4px; text-align: center; }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted); margin-bottom: 6px; }
  .card .big { font-size: 28px; font-weight: 700; }
  .card .sub { font-size: 12px; color: var(--text-muted); }

  .score-bar { height: 6px; background: #e0e0e0; border-radius: 3px; margin-top: 8px; overflow: hidden; }
  .score-fill { height: 100%; border-radius: 3px; transition: width .4s; }

  h2 { font-size: 16px; margin: 24px 0 12px; padding-bottom: 6px; border-bottom: 2px solid var(--border); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin-bottom: 24px; }
  th { background: #2a2a2a; color: #fff; text-align: left; padding: 9px 12px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  td { padding: 9px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  tbody tr:hover td { background: var(--surface-2); }

  .text-ok    { color: var(--success); font-weight: 600; }
  .text-warn  { color: var(--warning); font-weight: 600; }
  .text-error { color: var(--error); font-weight: 600; }
  .text-muted { color: var(--text-muted); font-style: italic; font-size: 12px; }

  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; }
  .badge-api    { background: #e8eaf6; color: #283593; }
  .badge-replay { background: #e8f5e9; color: #2e7d32; }

  .flow-tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; margin: 2px; font-family: 'Consolas', monospace; }
  .flow-ok      { background: #e8f5e9; color: #2e7d32; border: 1px solid #a5d6a7; }
  .flow-orphan  { background: #fff3e0; color: #e65100; border: 1px solid #ffcc02; }
  .flow-broken  { background: #fde8e8; color: #c0392b; border: 1px solid #ef9a9a; }

  .finding { padding: 12px 16px; border-radius: 6px; margin-bottom: 8px; }
  .finding-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
  .finding-icon { font-size: 14px; }
  .finding-sev  { font-weight: 700; font-size: 11px; text-transform: uppercase; }
  .finding-cat  { background: #e0e0e0; color: #333; padding: 1px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; }
  .finding-step { font-size: 11px; color: var(--text-muted); }
  .finding-script { font-size: 11px; color: var(--text-muted); font-family: 'Consolas', monospace; }
  .finding-msg  { font-size: 13px; margin-bottom: 4px; }
  .finding-rec  { font-size: 12px; color: var(--text-muted); font-style: italic; padding-left: 22px; }

  .footer { text-align: center; font-size: 11px; color: #999; margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--border); }
</style>
</head>
<body>
<div class="container">

  <!-- Header -->
  <div class="header">
    <div>
      <div class="header-grade" style="background: $gradeColor;">$grade</div>
      <div class="score-label">$overallScore / 100</div>
    </div>
    <div class="header-info">
      <h1>$([System.Web.HttpUtility]::HtmlEncode($workflow.name))</h1>
      <p>Quality evaluation &mdash; $(Get-Date -Format 'dd MMM yyyy HH:mm') &mdash; $($workflow.steps.Count) steps, $totalScripts scripts analysed</p>
      <p>$errorCount errors &bull; $warningCount warnings &bull; $infoCount suggestions</p>
    </div>
  </div>

  <!-- Score cards -->
  <div class="cards">
    <div class="card">
      <h3>Validation Coverage</h3>
      <div class="big" style="color: $(if($validationRatio -ge 50){'var(--success)'}elseif($validationRatio -ge 20){'var(--warning)'}else{'var(--error)'})">$validationRatio%</div>
      <div class="sub">validate steps vs input steps</div>
      <div class="score-bar"><div class="score-fill" style="width:${validationRatio}%; background:$(if($validationRatio -ge 50){'var(--success)'}elseif($validationRatio -ge 20){'var(--warning)'}else{'var(--error)'})"></div></div>
    </div>
    <div class="card">
      <h3>Script Coverage</h3>
      <div class="big" style="color: $(if($scriptCoverage -ge 75){'var(--success)'}elseif($scriptCoverage -ge 40){'var(--warning)'}else{'var(--error)'})">$scriptCoverage%</div>
      <div class="sub">scripts with at least 1 assertion</div>
      <div class="score-bar"><div class="score-fill" style="width:${scriptCoverage}%; background:$(if($scriptCoverage -ge 75){'var(--success)'}elseif($scriptCoverage -ge 40){'var(--warning)'}else{'var(--error)'})"></div></div>
    </div>
    <div class="card">
      <h3>Capture Usage</h3>
      <div class="big" style="color: $(if($captureUsage -ge 75){'var(--success)'}elseif($captureUsage -ge 40){'var(--warning)'}else{'var(--error)'})">$captureUsage%</div>
      <div class="sub">captured values consumed downstream</div>
      <div class="score-bar"><div class="score-fill" style="width:${captureUsage}%; background:$(if($captureUsage -ge 75){'var(--success)'}elseif($captureUsage -ge 40){'var(--warning)'}else{'var(--error)'})"></div></div>
    </div>
    <div class="card">
      <h3>Chain Integrity</h3>
      <div class="big" style="color: $(if($chainIntegrity -eq 100){'var(--success)'}else{'var(--error)'})">$chainIntegrity%</div>
      <div class="sub">inject &rarr; capture links valid</div>
      <div class="score-bar"><div class="score-fill" style="width:${chainIntegrity}%; background:$(if($chainIntegrity -eq 100){'var(--success)'}else{'var(--error)'})"></div></div>
    </div>
  </div>

  <!-- Parameter flow -->
  <h2>Parameter Flow</h2>
  <table>
    <thead><tr><th>Step</th><th>Type</th><th>User</th><th>Captures (output)</th><th>Injects (input)</th></tr></thead>
    <tbody>$flowRows</tbody>
  </table>

  <!-- Script analysis -->
  <h2>Script Analysis</h2>
  <table>
    <thead><tr><th>Script</th><th>Steps</th><th>Inputs</th><th>Validates</th><th>Captures</th><th>Findings</th></tr></thead>
    <tbody>$scriptRows</tbody>
  </table>

  <!-- Findings -->
  <h2>Findings &amp; Recommendations ($($findings.Count))</h2>
  $(if ($findings.Count -eq 0) { '<p style="color:var(--success);font-weight:600;">No findings — workflow follows best practices.</p>' } else { $findingsHtml })

  <div class="footer">
    Generated by 4PS Test Automation &mdash; Workflow Quality Evaluator &mdash; $(Get-Date -Format 'dd MMM yyyy HH:mm:ss')
  </div>

</div>
</body>
</html>
"@

$htmlPath = Join-Path $OutputPath "evaluation-report.html"
$html | Set-Content -Path $htmlPath -Encoding UTF8
Write-Status "HTML report: $htmlPath"

Write-Host ""
Write-Host "  Evaluation complete." -ForegroundColor Green
Write-Host ""
