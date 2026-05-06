<#
.SYNOPSIS
  Remove a ghost (non-existent path) entry from the shared snapshot file.

.DESCRIPTION
  Stop-gap utility used during the 2026-05-04 incident when stale MCP
  processes were resurrecting `E:\Developer\luff-ai-core\repo\event-crawler`
  after each save. Manually edits the JSON to drop the entry.

  WARNING: This does not lock the file. If a stale MCP process saves between
  your read and your write, your edit may be clobbered. Best practice is to
  run check-snapshot.ps1 immediately after to confirm the ghost stayed gone.
  After the v0.1.4-lufftw.3 snapshot fix is deployed across all sessions,
  ghosts auto-clean on next save and this script is rarely needed.

  See docs/lufftw/bugfix-2026-03-08-snapshot-race-condition.md.

.PARAMETER GhostPath
  The exact (case-sensitive) path key to remove. Required.

.PARAMETER ContextHome
  Override CLAUDE_CONTEXT_HOME. Default: env or ~/.context.

.EXAMPLE
  pwsh scripts/diagnostics/remove-snapshot-ghost.ps1 -GhostPath 'E:\Developer\luff-ai-core\repo\event-crawler'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$GhostPath,
    [string]$ContextHome = $(if ($env:CLAUDE_CONTEXT_HOME) { $env:CLAUDE_CONTEXT_HOME } else { Join-Path $env:USERPROFILE '.context' })
)

$snap = Join-Path $ContextHome 'mcp-codebase-snapshot.json'

if (-not (Test-Path $snap)) { throw "No snapshot at $snap" }

$j = Get-Content $snap -Raw | ConvertFrom-Json
if (-not ($j.codebases.PSObject.Properties.Name -contains $GhostPath)) {
    Write-Host "Ghost path not present in snapshot — no action." -ForegroundColor Yellow
    exit 0
}

if (Test-Path -LiteralPath $GhostPath) {
    Write-Host "REFUSING: '$GhostPath' actually exists on this filesystem. This is not a ghost." -ForegroundColor Red
    exit 1
}

$beforeCount = $j.codebases.PSObject.Properties.Count
$newCodebases = New-Object -TypeName PSObject
foreach ($p in $j.codebases.PSObject.Properties) {
    if ($p.Name -ne $GhostPath) {
        $newCodebases | Add-Member -MemberType NoteProperty -Name $p.Name -Value $p.Value
    }
}
$j.codebases = $newCodebases
$j.lastUpdated = (Get-Date -Format 'o')
$j | ConvertTo-Json -Depth 10 | Set-Content -Path $snap -Encoding UTF8

Write-Host "Removed ghost: $GhostPath" -ForegroundColor Green
Write-Host "  Entries: $beforeCount -> $($j.codebases.PSObject.Properties.Count)"
Write-Host "  Now run check-snapshot.ps1 to verify it stays gone."
