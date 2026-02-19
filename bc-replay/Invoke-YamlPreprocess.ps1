<#
.SYNOPSIS
    Preprocesses a BC page script YAML by updating parameter default values.

.DESCRIPTION
    Reads a BC page script YAML file and updates the default values in the
    native parameters section. BC page scripts use the syntax:

        value: =Parameters.'Page.Field'

    with a parameters section at the end of the file:

        parameters:
          Purchase Order List.No.:
            type: string
            default: IO210018

    This preprocessor updates the 'default:' value for each matching parameter,
    preserving the native BC recording structure.

    Falls back to {{PLACEHOLDER}} token replacement for scripts that don't use
    native parameters (e.g., hand-crafted templates).

.PARAMETER TemplatePath
    Path to the source YAML file containing BC native parameters.

.PARAMETER OutputPath
    Path where the processed YAML will be written.

.PARAMETER Substitutions
    Hashtable of key-value pairs. Keys are BC parameter names
    (e.g., "Purchase Order List.No.") and values are the new defaults.

.EXAMPLE
    Invoke-YamlPreprocess `
        -TemplatePath ".\Check PO with approver.yml" `
        -OutputPath ".\Check PO-ready.yml" `
        -Substitutions @{ "Purchase Order List.No." = "PO-001234" }

    Updates the default value for the 'Purchase Order List.No.' parameter.
#>

function Invoke-YamlPreprocess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$TemplatePath,

        [Parameter(Mandatory = $true)]
        [string]$OutputPath,

        [Parameter(Mandatory = $true)]
        [hashtable]$Substitutions
    )

    if (-not (Test-Path $TemplatePath)) {
        Write-Error "Template file not found: $TemplatePath"
        return
    }

    $content = Get-Content $TemplatePath -Raw
    $nativeReplaced = @()

    # ── Native BC parameter replacement ─────────────────────────────────────
    # Look for each substitution key as a BC parameter name in the parameters
    # section and update its default value.
    foreach ($key in $Substitutions.Keys) {
        $value = $Substitutions[$key]
        $escapedKey = [regex]::Escape($key)

        # Match: "  ParamName:\n    type: ...\n    default: OLD_VALUE"
        # The parameter name may contain dots and spaces, so we use the escaped key.
        $pattern = "(?m)(${escapedKey}:\s*\r?\n\s+type:\s+\w+\s*\r?\n\s+default:\s+)(.+)"
        if ($content -match $pattern) {
            $content = $content -replace $pattern, "`${1}${value}"
            $nativeReplaced += $key
            Write-Verbose "Updated parameter '$key' default to '$value'"
        }
    }

    # ── Fallback: {{PLACEHOLDER}} replacement ───────────────────────────────
    # For any keys that were NOT matched as native parameters, try the legacy
    # {{PLACEHOLDER}} approach (useful for hand-crafted template scripts).
    $remainingKeys = $Substitutions.Keys | Where-Object { $_ -notin $nativeReplaced }
    foreach ($key in $remainingKeys) {
        $placeholder = "{{$key}}"
        $value = $Substitutions[$key]

        if ($content -match [regex]::Escape($placeholder)) {
            $content = $content -replace [regex]::Escape($placeholder), $value
            Write-Verbose "Replaced $placeholder with '$value'"
        } else {
            Write-Warning "Parameter '$key' not found as native parameter or {{$key}} placeholder"
        }
    }

    # Ensure output directory exists
    $outputDir = Split-Path $OutputPath -Parent
    if ($outputDir -and -not (Test-Path $outputDir)) {
        New-Item -Path $outputDir -ItemType Directory -Force | Out-Null
    }

    Set-Content -Path $OutputPath -Value $content -NoNewline
    Write-Verbose "Processed YAML written to: $OutputPath"
}
