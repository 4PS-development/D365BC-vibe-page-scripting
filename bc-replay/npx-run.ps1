<#
.SYNOPSIS
    Run BC page scripting YAML files against a Business Central environment.

.DESCRIPTION
    Prompts for credentials securely and executes one or more YAML scripts
    via bc-replay (Playwright). Use this for single-user variant batch testing.

    For multi-user workflows (purchaser → approver etc.), use Run-BCWorkflow.ps1 instead.

.PARAMETER ScriptPath
    Path (or glob) to the YAML script(s) to run.
    Example: "..\page-scripting\MyProject\Variants\*.yml"
    Example: "..\page-scripting\PO Post DirectionsEMEA\Variants\*.yml"

.PARAMETER BcUrl
    Full URL to your BC environment.
    Example: "https://businesscentral.dynamics.com/mytenant.onmicrosoft.com/Sandbox"

.PARAMETER Username
    BC account email address. If not provided, you will be prompted.

.PARAMETER Headed
    Show the browser window during execution (useful for debugging).

.EXAMPLE
    .\npx-run.ps1 -ScriptPath "..\page-scripting\MyProject\Variants\*.yml" -BcUrl "https://businesscentral.dynamics.com/tenant/Sandbox"

.EXAMPLE
    .\npx-run.ps1 -ScriptPath "..\page-scripting\MyProject\BASE Recording.yml" -BcUrl "https://..." -Headed
#>

param(
    [Parameter(Mandatory = $false)]
    [string]$ScriptPath,

    [Parameter(Mandatory = $false)]
    [string]$BcUrl,

    [Parameter(Mandatory = $false)]
    [string]$Username,

    [switch]$Headed
)

$ErrorActionPreference = "Stop"

# ── Ensure we run from the bc-replay folder (where node_modules lives) ───────
Set-Location $PSScriptRoot

# ── Prompt for missing parameters ────────────────────────────────────────────
if (-not $ScriptPath) {
    $ScriptPath = Read-Host "Path to YAML script(s) (e.g. ..\page-scripting\MyProject\Variants\*.yml)"
}
if (-not $BcUrl) {
    $BcUrl = Read-Host "BC environment URL (e.g. https://businesscentral.dynamics.com/tenant/Sandbox)"
}
if (-not $Username) {
    $Username = Read-Host "BC account email (e.g. testuser@yourtenant.onmicrosoft.com)"
}

# ── Prompt for password securely ─────────────────────────────────────────────
$securePassword = Read-Host -AsSecureString "Password for $Username"
$plainPassword  = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
)

# ── Set credentials as environment variables ──────────────────────────────────
$env:BC_USERNAME = $Username
$env:BC_PASSWORD = $plainPassword

# ── Build npx replay arguments ────────────────────────────────────────────────
$replayArgs = @(
    "replay", $ScriptPath,
    "-StartAddress", $BcUrl,
    "-Authentication", "AAD",
    "-UserNameKey", "BC_USERNAME",
    "-PasswordKey", "BC_PASSWORD"
)
if ($Headed) { $replayArgs += "-Headed" }

# ── Run ───────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Running: npx $($replayArgs -join ' ')" -ForegroundColor DarkGray
Write-Host ""
npx @replayArgs

# ── Show report ───────────────────────────────────────────────────────────────
npx playwright show-report