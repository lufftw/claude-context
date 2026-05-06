<#
.SYNOPSIS
  Inspect the shared claude-context codebase snapshot and flag ghost entries.

.DESCRIPTION
  The shared snapshot lives under $env:CLAUDE_CONTEXT_HOME (default
  ~/.context). Every entry maps an absolute filesystem path to its indexing
  state. A "ghost" is an entry whose path no longer exists on disk; it
  indicates either a directory rename, a removed project, or a snapshot bug.

  This script lists every entry, marks ghosts, and prints a summary. It does
  NOT mutate the file. To clean ghosts, run remove-snapshot-ghost.ps1.

  Bug history: prior to v0.1.4-lufftw.3 (the fix on 2026-05-04),
  loadV2Format() in packages/mcp/src/snapshot.ts skipped ghosts on load but
  did not enroll them in `removedCodebases`, so the next merge-save re-read
  the ghost from disk and persisted it forever. See
  docs/lufftw/bugfix-2026-03-08-snapshot-race-condition.md ("Two Regressions
  Fixed on 2026-05-04").

.PARAMETER ContextHome
  Override CLAUDE_CONTEXT_HOME. Default: env or ~/.context.

.EXAMPLE
  pwsh scripts/diagnostics/check-snapshot.ps1
.EXAMPLE
  pwsh scripts/diagnostics/check-snapshot.ps1 -ContextHome E:/Developer/lufftw/repo/claude-control-center/mcp/61server/share/claude-context/.context
#>
[CmdletBinding()]
param(
    [string]$ContextHome = $(if ($env:CLAUDE_CONTEXT_HOME) { $env:CLAUDE_CONTEXT_HOME } else { Join-Path $env:USERPROFILE '.context' })
)

$snap = Join-Path $ContextHome 'mcp-codebase-snapshot.json'

if (-not (Test-Path $snap)) {
    Write-Host "No snapshot at $snap" -ForegroundColor Yellow
    exit 0
}

$j = Get-Content $snap -Raw | ConvertFrom-Json

Write-Host "`nSnapshot: $snap" -ForegroundColor Cyan
Write-Host "  formatVersion: $($j.formatVersion)"
Write-Host "  lastUpdated:   $($j.lastUpdated)"
Write-Host ""

$ghosts = @()
$entries = @($j.codebases.PSObject.Properties)

foreach ($p in $entries) {
    $exists = Test-Path -LiteralPath $p.Name
    $info = $p.Value
    $marker = if ($exists) { '✅' } else { '❌GHOST'; $ghosts += $p.Name }
    "{0,-9} {1,-65} status={2,-12} chunks={3,-7} files={4}" -f `
        $marker, $p.Name, $info.status, $info.totalChunks, $info.indexedFiles
}

Write-Host ""
Write-Host "Total: $($entries.Count) entries, $($ghosts.Count) ghosts" -ForegroundColor $(if ($ghosts.Count -eq 0) { 'Green' } else { 'Yellow' })

if ($ghosts.Count -gt 0) {
    Write-Host "`nGhost paths (run remove-snapshot-ghost.ps1 to clean):" -ForegroundColor Yellow
    $ghosts | ForEach-Object { "  $_" }
}
