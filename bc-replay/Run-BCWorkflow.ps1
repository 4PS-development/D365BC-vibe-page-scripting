<#
.SYNOPSIS
    Orchestrates multi-user BC page scripting workflows.

.DESCRIPTION
    Executes a sequence of BC page scripts, each potentially with different user
    credentials, passing state (captured values) between steps via YAML preprocessing.

    Core concepts:
    - workflow.json defines steps, users, scripts, capture/inject rules
    - users.json maps role names to environment variable names for credentials
    - Each step runs as a separate bc-replay invocation with its own credentials
    - Captured values from one step can be injected into the next step's YAML

.PARAMETER WorkflowPath
    Path to workflow.json (or the project folder containing it).

.PARAMETER UsersPath
    Path to users.json. Defaults to users.json in the same folder as workflow.json.

.PARAMETER ResultDir
    Base output directory for results. Each step gets a subfolder.
    Defaults to ./results/ relative to the workflow folder.

.PARAMETER Headed
    Show the browser window during execution (for debugging).

.PARAMETER StopOnFailure
    Stop the workflow if any step fails. Default: $true.

.PARAMETER DryRun
    Preview what would happen without executing any bc-replay commands.

.EXAMPLE
    .\Run-BCWorkflow.ps1 -WorkflowPath "..\page-scripting\PO Approval Workflow"
    
.EXAMPLE
    .\Run-BCWorkflow.ps1 -WorkflowPath "..\page-scripting\PO Approval Workflow\workflow.json" -Headed -DryRun
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$WorkflowPath,

    [Parameter(Mandatory = $false)]
    [string]$UsersPath,

    [Parameter(Mandatory = $false)]
    [string]$ResultDir,

    [Parameter(Mandatory = $false)]
    [switch]$Headed = $false,

    [Parameter(Mandatory = $false)]
    [switch]$StopOnFailure = $true,

    [Parameter(Mandatory = $false)]
    [switch]$DryRun = $false
)

$ErrorActionPreference = "Stop"

# ── Import modules ──────────────────────────────────────────────────────────
$scriptRoot = $PSScriptRoot
. (Join-Path $scriptRoot "Invoke-YamlPreprocess.ps1")
. (Join-Path $scriptRoot "New-WorkflowReport.ps1")

# ── Resolve paths ───────────────────────────────────────────────────────────
if (Test-Path $WorkflowPath -PathType Container) {
    $workflowFolder = Resolve-Path $WorkflowPath
    $WorkflowPath  = Join-Path $workflowFolder "workflow.json"
} else {
    $workflowFolder = Split-Path (Resolve-Path $WorkflowPath) -Parent
}

if (-not (Test-Path $WorkflowPath)) {
    Write-Error "workflow.json not found at: $WorkflowPath"
    exit 1
}

if (-not $UsersPath) {
    $UsersPath = Join-Path $workflowFolder "users.json"
}
if (-not (Test-Path $UsersPath)) {
    Write-Error "users.json not found at: $UsersPath"
    exit 1
}

if (-not $ResultDir) {
    $ResultDir = Join-Path $workflowFolder "results"
}

# ── Load configuration ─────────────────────────────────────────────────────
$workflow = Get-Content $WorkflowPath -Raw | ConvertFrom-Json
$users    = Get-Content $UsersPath -Raw | ConvertFrom-Json

Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  BC Multi-User Workflow Orchestrator" -ForegroundColor White
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Workflow : $($workflow.name)" -ForegroundColor White
Write-Host "  Steps    : $($workflow.steps.Count)" -ForegroundColor White
Write-Host "  BC URL   : $($workflow.bc_url)" -ForegroundColor White
Write-Host "  Results  : $ResultDir" -ForegroundColor White
if ($DryRun) { Write-Host "  Mode     : DRY RUN (no execution)" -ForegroundColor Yellow }
if ($Headed) { Write-Host "  Browser  : Headed (visible)" -ForegroundColor Yellow }
Write-Host ""

# ── Validate user credentials ──────────────────────────────────────────────
$requiredUsers = $workflow.steps | ForEach-Object { $_.user } | Sort-Object -Unique

foreach ($role in $requiredUsers) {
    $userConfig = $users.PSObject.Properties[$role]
    if (-not $userConfig) {
        Write-Error "User role '$role' referenced in workflow but not defined in users.json"
        exit 1
    }
    $u = $userConfig.Value
    if (-not $u.username) {
        Write-Warning "No 'username' defined for user '$role' in users.json"
    }
    if (-not $u.password) {
        Write-Warning "No 'password' defined for user '$role' in users.json"
    }
}

# ── Prepare results directory ──────────────────────────────────────────────
if (-not (Test-Path $ResultDir)) {
    New-Item -Path $ResultDir -ItemType Directory -Force | Out-Null
}

# ── State management ───────────────────────────────────────────────────────
$workflowState = @{}
$stepResults   = @()
$workflowStart = Get-Date

# ── Execute steps sequentially ─────────────────────────────────────────────
$stepIndex = 0
foreach ($step in $workflow.steps) {
    $stepIndex++
    $stepStart = Get-Date
    $stepResultDir = Join-Path $ResultDir "step-$($step.id)"
    New-Item -ItemType Directory -Path $stepResultDir -Force | Out-Null

    Write-Host "──────────────────────────────────────────────────────" -ForegroundColor DarkGray
    Write-Host "  Step $stepIndex/$($workflow.steps.Count): $($step.name)" -ForegroundColor Cyan
    Write-Host "  User: $($step.user)  |  Script: $($step.script)" -ForegroundColor Gray
    Write-Host ""

    # 1. Check dependency
    if ($step.depends_on) {
        $depId = $step.depends_on
        $depResult = $stepResults | Where-Object { $_.id -eq $depId }
        if ($depResult -and $depResult.exit_code -ne 0) {
            Write-Host "  SKIPPED - dependency '$depId' failed" -ForegroundColor Yellow
            $stepResults += [PSCustomObject]@{
                id         = $step.id
                name       = $step.name
                user       = $step.user
                status     = "skipped"
                exit_code  = -1
                start_time = $stepStart
                end_time   = Get-Date
                duration_s = 0
                report_dir = $null
                reason     = "Dependency '$depId' failed"
            }
            continue
        }
    }

    # 2. Resolve script path (relative to workflow folder)
    $scriptPath = Join-Path $workflowFolder $step.script
    if (-not (Test-Path $scriptPath)) {
        Write-Error "Script not found: $scriptPath"
        exit 1
    }

    # 3. YAML preprocessing - inject captured values from previous steps
    $processedScript = $scriptPath
    if ($step.inject) {
        $substitutions = @{}
        foreach ($prop in $step.inject.PSObject.Properties) {
            $key   = $prop.Name
            $value = $prop.Value

            # Resolve {capture.<step-id>.<field>} references
            if ($value -match '^\{capture\.([^.]+)\.([^}]+)\}$') {
                $sourceStep  = $Matches[1]
                $sourceField = $Matches[2]
                if ($workflowState.ContainsKey($sourceStep) -and $workflowState[$sourceStep].ContainsKey($sourceField)) {
                    $substitutions[$key] = $workflowState[$sourceStep][$sourceField]
                } else {
                    Write-Warning "  Capture reference not found: capture.$sourceStep.$sourceField"
                    $substitutions[$key] = ""
                }
            } else {
                # Literal value
                $substitutions[$key] = $value
            }
        }

        if ($substitutions.Count -gt 0) {
            $processedDir = Join-Path $stepResultDir "processed"
            if (-not (Test-Path $processedDir)) {
                New-Item -Path $processedDir -ItemType Directory -Force | Out-Null
            }
            $processedScript = Join-Path $processedDir (Split-Path $scriptPath -Leaf)

            Write-Host "  Injecting parameter values:" -ForegroundColor DarkYellow
            foreach ($k in $substitutions.Keys) {
                Write-Host "    $k = $($substitutions[$k])" -ForegroundColor DarkYellow
            }

            Invoke-YamlPreprocess `
                -TemplatePath $scriptPath `
                -OutputPath $processedScript `
                -Substitutions $substitutions
        }
    }

    # 4. Set credentials as temporary env vars for bc-replay
    #    bc-replay reads credentials from env vars via -UserNameKey/-PasswordKey
    $userConfig = $users.PSObject.Properties[$step.user].Value
    $env:BC_WF_USERNAME = $userConfig.username
    $env:BC_WF_PASSWORD = $userConfig.password

    # 5. Build npx replay command
    $replayArgs = @(
        "replay"
        $processedScript
        "-StartAddress", $workflow.bc_url
        "-Authentication", "AAD"
        "-UserNameKey", "BC_WF_USERNAME"
        "-PasswordKey", "BC_WF_PASSWORD"
        "-ResultDir", $stepResultDir
    )

    # Add MFA flags if user has mfa_seed configured AND bc-replay supports it
    if ($userConfig.mfa_seed) {
        # Check if installed bc-replay version supports -MultiFactorType
        $replayScript = Join-Path $PSScriptRoot "node_modules\@microsoft\bc-replay\Replay.ps1"
        $supportsMFA = $false
        if (Test-Path $replayScript) {
            $supportsMFA = (Get-Content $replayScript -Raw) -match 'MultiFactorType'
        }
        if ($supportsMFA) {
            $replayArgs += "-MultiFactorType", "TOTP"
            $replayArgs += "-MultiFactorSecretKey", $userConfig.mfa_seed
        } else {
            Write-Warning "  MFA seed configured for '$($step.user)' but bc-replay does not support -MultiFactorType. Upgrade bc-replay or use the MFA patch."
        }
    }

    if ($Headed) {
        $replayArgs += "-Headed"
    }

    # 6. Execute bc-replay
    $exitCode = 0
    if ($DryRun) {
        Write-Host "  [DRY RUN] npx $($replayArgs -join ' ')" -ForegroundColor Yellow
    } else {
        Write-Host "  Running: npx $($replayArgs -join ' ')" -ForegroundColor DarkGray
        Write-Host ""

        # Set PLAYWRIGHT_HTML_TITLE for labelled reports
        $env:PLAYWRIGHT_HTML_TITLE = "Step $stepIndex - $($step.name) ($($step.user))"

        # npx must run from bc-replay/ where node_modules is installed
        $bcReplayDir = $PSScriptRoot
        Push-Location $bcReplayDir
        try {
            & npx @replayArgs
            $exitCode = $LASTEXITCODE
        } catch {
            Write-Warning "  bc-replay execution error: $_"
            $exitCode = 1
        } finally {
            Pop-Location
        }
    }

    # 7. Read captured state from replay log
    #    BC's copy-value steps write copiedValue into the replay log YAML.
    #    The replay log is in the Playwright report data directory.
    if ($step.capture -and -not $DryRun -and $exitCode -eq 0) {
        $capturedHash = @{}

        # Find the replay log in the Playwright report data
        $replayLogDir = Join-Path $stepResultDir "playwright-report\data"
        $replayLogFiles = @()
        if (Test-Path $replayLogDir) {
            $replayLogFiles = Get-ChildItem $replayLogDir -Filter "*.yml" |
                Where-Object { $_.Length -gt 4000 } |   # replay log is larger than the recording
                Sort-Object Length -Descending
        }

        $replayLog = $null
        foreach ($logFile in $replayLogFiles) {
            $content = Get-Content $logFile.FullName -Raw
            if ($content -match "copiedValue:") {
                $replayLog = $content
                Write-Host "  Found replay log: $($logFile.Name)" -ForegroundColor DarkGray
                break
            }
        }

        if ($replayLog) {
            # Extract copy-value results: match "name: X" followed by "copiedValue: Y"
            foreach ($prop in $step.capture.PSObject.Properties) {
                $captureKey = $prop.Name          # e.g., "po_number"
                $copyValueName = $prop.Value       # e.g., "Purchase Order - No."
                $escapedName = [regex]::Escape($copyValueName)

                # Pattern: name: <copyValueName> ... copiedValue: <value>
                if ($replayLog -match "name:\s+${escapedName}[\s\S]*?copiedValue:\s+(.+)") {
                    $capturedHash[$captureKey] = $Matches[1].Trim()
                    Write-Host "  Captured: $captureKey = $($capturedHash[$captureKey])" -ForegroundColor Green
                } else {
                    Write-Warning "  copy-value '$copyValueName' not found in replay log"
                }
            }
        } else {
            Write-Host "  No copiedValue found in replay log" -ForegroundColor Yellow
        }

        if ($capturedHash.Count -gt 0) {
            $workflowState[$step.id] = $capturedHash
        }
    }

    # Clean up credential env vars (don't leave them in memory)
    Remove-Item env:BC_WF_USERNAME -ErrorAction SilentlyContinue
    Remove-Item env:BC_WF_PASSWORD -ErrorAction SilentlyContinue

    # 8. Record step result
    $stepEnd = Get-Date
    $status = if ($exitCode -eq 0) { "passed" } elseif ($DryRun) { "dry-run" } else { "failed" }

    $stepResults += [PSCustomObject]@{
        id         = $step.id
        name       = $step.name
        user       = $step.user
        status     = $status
        exit_code  = $exitCode
        start_time = $stepStart
        end_time   = $stepEnd
        duration_s = [math]::Round(($stepEnd - $stepStart).TotalSeconds, 1)
        report_dir = $stepResultDir
    }

    # Status output
    $statusColor = if ($status -eq "passed") { "Green" } elseif ($status -eq "dry-run") { "Yellow" } else { "Red" }
    Write-Host ""
    Write-Host "  Result: $($status.ToUpper()) (exit code: $exitCode, duration: $([math]::Round(($stepEnd - $stepStart).TotalSeconds, 1))s)" -ForegroundColor $statusColor

    # Stop on failure if configured
    if ($StopOnFailure -and $exitCode -ne 0 -and -not $DryRun) {
        Write-Host ""
        Write-Host "  Workflow stopped - step failed and -StopOnFailure is set" -ForegroundColor Red
        break
    }
}

# ── Save state checkpoint ──────────────────────────────────────────────────
$statePath = Join-Path $ResultDir "workflow-state.json"
$workflowState | ConvertTo-Json -Depth 10 | Set-Content -Path $statePath
Write-Host ""
Write-Host "State saved: $statePath" -ForegroundColor DarkGray

# ── Generate workflow summary report ───────────────────────────────────────
$workflowEnd = Get-Date

New-WorkflowReport `
    -WorkflowName $workflow.name `
    -StepResults $stepResults `
    -OutputDir $ResultDir `
    -WorkflowStart $workflowStart `
    -WorkflowEnd $workflowEnd

# ── Summary ────────────────────────────────────────────────────────────────
$passed  = ($stepResults | Where-Object { $_.status -eq "passed" }).Count
$failed  = ($stepResults | Where-Object { $_.status -eq "failed" }).Count
$skipped = ($stepResults | Where-Object { $_.status -eq "skipped" }).Count

Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  Workflow Complete" -ForegroundColor White
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  Passed : $passed" -ForegroundColor Green
Write-Host "  Failed : $failed" -ForegroundColor $(if ($failed -gt 0) { "Red" } else { "Gray" })
Write-Host "  Skipped: $skipped" -ForegroundColor $(if ($skipped -gt 0) { "Yellow" } else { "Gray" })
Write-Host "  Total  : $($workflow.steps.Count) steps, $([math]::Round(($workflowEnd - $workflowStart).TotalSeconds, 1))s" -ForegroundColor White
Write-Host ""
$reportPath = Join-Path $ResultDir 'workflow-summary.html'
Write-Host "  Report : $reportPath" -ForegroundColor Cyan
Write-Host ""

# Open the HTML report in the default browser
if (Test-Path $reportPath) {
    Start-Process $reportPath
}

# Exit with failure code if any step failed
if ($failed -gt 0) { exit 1 }
