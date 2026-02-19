<#
.SYNOPSIS
    Applies the capture patch to bc-replay's commands.js.

.DESCRIPTION
    Patches node_modules/@microsoft/bc-replay/player/dist/commands.js to add
    field value capture support. After a script finishes, captured field values
    are written to a JSON file for the workflow orchestrator to read.

    This follows the same proven pattern as apply-mfa-patch.ps1.

    Requires: npm install (bc-replay must be installed first)

    Environment variables used at runtime:
      BC_CAPTURE_FIELDS  - JSON object mapping names to field captions
                           e.g. {"po_number":"No.","status":"Status"}
      BC_CAPTURE_OUTPUT  - Path to write capture.json (default: ./capture.json)

.EXAMPLE
    .\apply-capture-patch.ps1

.NOTES
    The actual patch content (capture.js.patch) needs to be created after
    inspecting the installed commands.js structure. Run npm install first,
    then inspect commands.js to identify the correct hook point.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

Write-Host "`nBC-Replay Capture Patch Installer" -ForegroundColor Cyan
Write-Host ("=" * 50) -ForegroundColor Cyan

# Find bc-replay installation
$targetFile = Join-Path $PSScriptRoot ".." "node_modules" "@microsoft" "bc-replay" "player" "dist" "commands.js"

if (-not (Test-Path $targetFile)) {
    Write-Host "`nERROR: bc-replay not found!" -ForegroundColor Red
    Write-Host "`nExpected location: $targetFile" -ForegroundColor Yellow
    Write-Host "`nPlease ensure:" -ForegroundColor Yellow
    Write-Host "  1. You're in the bc-replay/bc-replay-capture-solution/ folder" -ForegroundColor Yellow
    Write-Host "  2. You've run 'npm install' in the bc-replay/ folder" -ForegroundColor Yellow
    exit 1
}

Write-Host "`nFound bc-replay installation" -ForegroundColor Green
Write-Verbose "Target file: $targetFile"

# Read current file
Write-Host "`nReading commands.js..." -ForegroundColor Yellow
$content = Get-Content $targetFile -Raw

# Check if already patched
$marker = "BC_CAPTURE_FIELDS"
if ($content -match $marker) {
    Write-Host "`nCapture patch already applied!" -ForegroundColor Green
    Write-Host "No changes needed." -ForegroundColor Cyan
    exit 0
}

# Check for patch file
$patchFile = Join-Path $PSScriptRoot "capture.js.patch"
if (-not (Test-Path $patchFile)) {
    Write-Host "`nERROR: Patch file not found: $patchFile" -ForegroundColor Red
    Write-Host "`nThe capture patch has not been created yet." -ForegroundColor Yellow
    Write-Host "This is a scaffolding - the actual patch requires:" -ForegroundColor Yellow
    Write-Host "  1. Run 'npm install' in bc-replay/" -ForegroundColor Yellow
    Write-Host "  2. Inspect commands.js to find the step execution hook point" -ForegroundColor Yellow
    Write-Host "  3. Create capture.js.patch with the capture code" -ForegroundColor Yellow
    Write-Host "`nSee: docs/MULTI-USER-WORKFLOW-PLAN.md > Step 4" -ForegroundColor Cyan
    exit 1
}

# Create backup
$backupFile = "$targetFile.backup-capture-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Write-Host "`nCreating backup..." -ForegroundColor Yellow
Copy-Item $targetFile $backupFile -Force
Write-Host "   Backup: $backupFile" -ForegroundColor Gray

# Read and apply patch
Write-Host "`nReading patch file..." -ForegroundColor Yellow
$patchContent = Get-Content $patchFile -Raw

# The insertion pattern will need to be determined after inspecting commands.js
# This is a placeholder - the actual regex depends on the commands.js structure
$insertionPattern = '(?s)(// CAPTURE_HOOK_POINT)'  # Placeholder

if ($content -notmatch $insertionPattern) {
    Write-Host "`nERROR: Could not find insertion point in commands.js" -ForegroundColor Red
    Write-Host "The file structure may have changed. Check capture.js.patch." -ForegroundColor Yellow
    # Restore backup
    Copy-Item $backupFile $targetFile -Force
    exit 1
}

# Apply patch
Write-Host "`nApplying capture patch..." -ForegroundColor Yellow
$patchedContent = $content -replace $insertionPattern, "`$1`n$patchContent"

# Write patched file
Set-Content $targetFile $patchedContent -NoNewline

# Verify
$verifyContent = Get-Content $targetFile -Raw
if ($verifyContent -match $marker) {
    Write-Host "`nSUCCESS! Capture patch applied!" -ForegroundColor Green
    Write-Host "`nThe orchestrator can now capture field values between workflow steps." -ForegroundColor Cyan
    Write-Host "Rerun this script after 'npm install' to reapply." -ForegroundColor Yellow
} else {
    Write-Host "`nERROR: Verification failed!" -ForegroundColor Red
    Write-Host "Restoring from backup..." -ForegroundColor Yellow
    Copy-Item $backupFile $targetFile -Force
    Write-Host "Backup restored." -ForegroundColor Green
    exit 1
}

Write-Host ""
