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

# ── Validate bc-replay version ───────────────────────────────────────────────
$minBcReplayVersion = [version]"0.1.100"  # Minimum version that supports -MultiFactorType TOTP
$bcReplayPkg = Join-Path $scriptRoot "node_modules\@microsoft\bc-replay\package.json"
if (Test-Path $bcReplayPkg) {
    $installedVersion = [version]((Get-Content $bcReplayPkg -Raw | ConvertFrom-Json).version)
    if ($installedVersion -lt $minBcReplayVersion) {
        Write-Warning "bc-replay v$installedVersion is installed, but v$minBcReplayVersion or later is required for TOTP/MFA support."
        Write-Warning "Run: npm install @microsoft/bc-replay@latest   (in the bc-replay folder)"
    } else {
        Write-Host "  bc-replay : v$installedVersion" -ForegroundColor DarkGray
    }
} else {
    Write-Error "bc-replay is not installed. Run: npm install   (in the bc-replay folder)"
    exit 1
}

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

# ── Pre-run validation ──────────────────────────────────────────────────────
Write-Host "  Validating configuration..." -ForegroundColor DarkGray
$validationErrors = @()

# 1. BC URL must be a valid URL
if (-not $workflow.bc_url) {
    $validationErrors += "workflow.json: 'bc_url' is missing."
} elseif ($workflow.bc_url -notmatch '^https?://') {
    $validationErrors += "workflow.json: 'bc_url' does not look like a valid URL: '$($workflow.bc_url)'"
} elseif ($workflow.bc_url -match 'YOUR_TENANT|your-tenant|placeholder') {
    $validationErrors += "workflow.json: 'bc_url' still contains a placeholder value. Update it with your real BC URL."
}

# 2. All script paths must exist
$definedStepIds = @($workflow.steps | ForEach-Object { $_.id })
foreach ($step in $workflow.steps) {
    $scriptsToCheck = @()
    if ($step.scripts -and $step.scripts.Count -gt 0) { $scriptsToCheck = @($step.scripts) }
    elseif ($step.script) { $scriptsToCheck = @($step.script) }
    else { $validationErrors += "Step '$($step.id)': no 'script' or 'scripts' defined." }

    foreach ($rel in $scriptsToCheck) {
        $abs = Join-Path $workflowFolder $rel
        if (-not (Test-Path $abs)) {
            $validationErrors += "Step '$($step.id)': script not found: $abs"
        }
    }
}

# 3. All users referenced in steps must exist in users.json and have credentials
foreach ($step in $workflow.steps) {
    $role = $step.user
    $userConfig = $users.PSObject.Properties[$role]
    if (-not $userConfig) {
        $validationErrors += "Step '$($step.id)': user role '$role' not found in users.json. Add it or update users.json."
    } else {
        $u = $userConfig.Value
        if (-not $u.username -or $u.username -match 'yourtenant|placeholder|your-') {
            $validationErrors += "Step '$($step.id)': username for role '$role' is missing or still a placeholder in users.json."
        }
        if (-not $u.password -or $u.password -match 'your-password-here|placeholder') {
            $validationErrors += "Step '$($step.id)': password for role '$role' is missing or still a placeholder in users.json."
        }
    }
}

# 4. All inject expressions must reference captures defined in earlier steps
$captureRegistry = @{}  # stepId -> @(varName, ...)
foreach ($step in $workflow.steps) {
    if ($step.capture) {
        $captureRegistry[$step.id] = @($step.capture.PSObject.Properties.Name)
    }
    if ($step.inject) {
        foreach ($prop in $step.inject.PSObject.Properties) {
            $ref = $prop.Value
            if ($ref -match '\{capture\.([^.]+)\.([^}]+)\}') {
                $srcStep = $Matches[1]
                $srcVar  = $Matches[2]
                if ($captureRegistry.ContainsKey($srcStep)) {
                    if ($srcVar -notin $captureRegistry[$srcStep]) {
                        $validationErrors += "Step '$($step.id)': inject references undefined capture variable '$srcVar' in step '$srcStep'."
                    }
                } else {
                    $validationErrors += "Step '$($step.id)': inject references step '$srcStep' which has no captures defined."
                }
            }
        }
    }
}

# 5. depends_on must reference a valid step ID
foreach ($step in $workflow.steps) {
    if ($step.depends_on -and $step.depends_on -notin $definedStepIds) {
        $validationErrors += "Step '$($step.id)': depends_on references unknown step '$($step.depends_on)'."
    }
}

# Report results
if ($validationErrors.Count -gt 0) {
    Write-Host ""
    Write-Host "  Configuration errors found. Please fix these before running:" -ForegroundColor Red
    Write-Host ""
    foreach ($err in $validationErrors) {
        Write-Host "  [X] $err" -ForegroundColor Red
    }
    Write-Host ""
    Write-Host "  Tip: Open the Workflow Builder (tools/workflow-builder/index.html) to edit your workflow visually." -ForegroundColor Yellow
    Write-Host "       Copy users.sample.json to users.json and fill in real credentials." -ForegroundColor Yellow
    Write-Host ""
    exit 1
} else {
    Write-Host "  All checks passed." -ForegroundColor Green
    Write-Host ""
}

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

    # Resolve scripts list: support both "script" (string) and "scripts" (array)
    $scriptsList = @()
    if ($step.scripts -and $step.scripts.Count -gt 0) {
        $scriptsList = @($step.scripts)
    } elseif ($step.script) {
        $scriptsList = @($step.script)
    } else {
        Write-Error "Step '$($step.id)' has no 'script' or 'scripts' defined"
        exit 1
    }
    $isMultiScript = $scriptsList.Count -gt 1

    Write-Host "──────────────────────────────────────────────────────" -ForegroundColor DarkGray
    Write-Host "  Step $stepIndex/$($workflow.steps.Count): $($step.name)" -ForegroundColor Cyan
    if ($isMultiScript) {
        Write-Host "  User: $($step.user)  |  Scripts: $($scriptsList.Count)" -ForegroundColor Gray
    } else {
        Write-Host "  User: $($step.user)  |  Script: $($scriptsList[0])" -ForegroundColor Gray
    }
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

    # 2. Set credentials as temporary env vars for bc-replay
    $userConfig = $users.PSObject.Properties[$step.user].Value
    $env:BC_WF_USERNAME = $userConfig.username
    $env:BC_WF_PASSWORD = $userConfig.password

    # 3. Build MFA args if seed is configured
    $mfaArgs = @()
    if ($userConfig.mfa_seed) {
        # -MultiFactorSecretKey expects an env var name, not the raw seed value
        $env:BC_WF_MFA_KEY = $userConfig.mfa_seed
        $mfaArgs = @("-MultiFactorType", "TOTP", "-MultiFactorSecretKey", "BC_WF_MFA_KEY")
        Write-Host "  MFA      : TOTP enabled for '$($step.user)'" -ForegroundColor DarkGray
    }

    # 4. Execute each script in the step
    $subResults = @()
    $stepExitCode = 0
    $scriptIndex = 0

    foreach ($scriptRelPath in $scriptsList) {
        $scriptIndex++
        $scriptStart = Get-Date

        # Determine result dir: sub-folder per script if multi-script, else the step dir
        if ($isMultiScript) {
            $scriptResultDir = Join-Path $stepResultDir "script-$scriptIndex"
            New-Item -ItemType Directory -Path $scriptResultDir -Force | Out-Null
            $scriptLabel = Split-Path $scriptRelPath -Leaf
            Write-Host "  Script $scriptIndex/$($scriptsList.Count): $scriptLabel" -ForegroundColor DarkCyan
        } else {
            $scriptResultDir = $stepResultDir
        }

        # Resolve script path
        $scriptPath = Join-Path $workflowFolder $scriptRelPath
        if (-not (Test-Path $scriptPath)) {
            Write-Error "Script not found: $scriptPath"
            exit 1
        }

        # YAML preprocessing - inject captured values from previous steps
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
                    $substitutions[$key] = $value
                }
            }

            if ($substitutions.Count -gt 0) {
                $processedDir = Join-Path $scriptResultDir "processed"
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

        # Build npx replay command
        $replayArgs = @(
            "replay"
            $processedScript
            "-StartAddress", $workflow.bc_url
            "-Authentication", "AAD"
            "-UserNameKey", "BC_WF_USERNAME"
            "-PasswordKey", "BC_WF_PASSWORD"
            "-ResultDir", $scriptResultDir
        )
        $replayArgs += $mfaArgs
        if ($Headed) { $replayArgs += "-Headed" }

        # Execute bc-replay
        $exitCode = 0
        if ($DryRun) {
            Write-Host "  [DRY RUN] npx $($replayArgs -join ' ')" -ForegroundColor Yellow
        } else {
            Write-Host "  Running: npx $($replayArgs -join ' ')" -ForegroundColor DarkGray
            Write-Host ""

            if ($isMultiScript) {
                $env:PLAYWRIGHT_HTML_TITLE = "Step $stepIndex.$scriptIndex - $($step.name) ($($step.user))"
            } else {
                $env:PLAYWRIGHT_HTML_TITLE = "Step $stepIndex - $($step.name) ($($step.user))"
            }

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

        $scriptEnd = Get-Date

        # Read captured state from replay log (scan this script's result dir)
        if ($step.capture -and -not $DryRun -and $exitCode -eq 0) {
            $capturedHash = @{}
            $replayLogDir = Join-Path $scriptResultDir "playwright-report\data"
            $replayLogFiles = @()
            if (Test-Path $replayLogDir) {
                $replayLogFiles = Get-ChildItem $replayLogDir -Filter "*.yml" |
                    Where-Object { $_.Length -gt 4000 } |
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
                foreach ($prop in $step.capture.PSObject.Properties) {
                    $captureKey = $prop.Name
                    $copyValueName = $prop.Value
                    $escapedName = [regex]::Escape($copyValueName)

                    if ($replayLog -match "name:\s+${escapedName}[\s\S]*?copiedValue:\s+(.+)") {
                        $capturedHash[$captureKey] = $Matches[1].Trim()
                        Write-Host "  Captured: $captureKey = $($capturedHash[$captureKey])" -ForegroundColor Green
                    } else {
                        Write-Warning "  copy-value '$copyValueName' not found in replay log"
                    }
                }
            }

            # Merge captures into workflow state (last script wins for duplicates)
            if ($capturedHash.Count -gt 0) {
                if (-not $workflowState.ContainsKey($step.id)) {
                    $workflowState[$step.id] = @{}
                }
                foreach ($k in $capturedHash.Keys) {
                    $workflowState[$step.id][$k] = $capturedHash[$k]
                }
            }
        }

        # Track sub-result for multi-script steps
        if ($isMultiScript) {
            $scriptStatus = if ($exitCode -eq 0) { "passed" } elseif ($DryRun) { "dry-run" } else { "failed" }
            $subResults += [PSCustomObject]@{
                script     = $scriptRelPath
                label      = Split-Path $scriptRelPath -Leaf
                status     = $scriptStatus
                exit_code  = $exitCode
                start_time = $scriptStart
                end_time   = $scriptEnd
                duration_s = [math]::Round(($scriptEnd - $scriptStart).TotalSeconds, 1)
                report_dir = $scriptResultDir
            }

            $statusColor = if ($scriptStatus -eq "passed") { "Green" } elseif ($scriptStatus -eq "dry-run") { "Yellow" } else { "Red" }
            Write-Host "  Script $scriptIndex result: $($scriptStatus.ToUpper()) ($([math]::Round(($scriptEnd - $scriptStart).TotalSeconds, 1))s)" -ForegroundColor $statusColor
            Write-Host ""
        }

        # Track worst exit code across scripts in this step
        if ($exitCode -ne 0) { $stepExitCode = $exitCode }

        # Stop remaining scripts in this step if one fails
        if ($exitCode -ne 0 -and -not $DryRun) {
            if ($isMultiScript -and $scriptIndex -lt $scriptsList.Count) {
                Write-Host "  Remaining scripts skipped due to failure" -ForegroundColor Yellow
            }
            break
        }
    }

    # Clean up credential env vars
    Remove-Item env:BC_WF_USERNAME -ErrorAction SilentlyContinue
    Remove-Item env:BC_WF_PASSWORD -ErrorAction SilentlyContinue

    # 5. Record step result
    $stepEnd = Get-Date
    $status = if ($stepExitCode -eq 0) { "passed" } elseif ($DryRun) { "dry-run" } else { "failed" }

    $stepResult = [PSCustomObject]@{
        id          = $step.id
        name        = $step.name
        user        = $step.user
        status      = $status
        exit_code   = $stepExitCode
        start_time  = $stepStart
        end_time    = $stepEnd
        duration_s  = [math]::Round(($stepEnd - $stepStart).TotalSeconds, 1)
        report_dir  = $stepResultDir
        sub_results = if ($isMultiScript) { $subResults } else { $null }
    }
    $stepResults += $stepResult

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
