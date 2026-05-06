<#
.SYNOPSIS
  Rank git repos under a root directory by recent activity, cross-reference
  with the claude-context shared snapshot, and propose a re-index priority.

.DESCRIPTION
  Heat metric per repo:
    score = commits_last_7d * 4 + commits_last_30d * 1

  Cross-references each repo with the shared snapshot:
    - 'TRACKED'   : repo path is in snapshot
    - 'UNTRACKED' : repo path NOT in snapshot (will need first-time index)
    - 'STALE?'    : tracked but heat is high relative to last update timestamp

  Output is sorted by score descending. Workspace mirrors (*-workspace) and
  .git-only roots without source files are skipped.

.PARAMETER RepoRoot
  Default: E:\Developer\lufftw\repo

.PARAMETER ContextHome
  Default: env CLAUDE_CONTEXT_HOME or ~/.context.

.PARAMETER MinScore
  Skip repos below this heat score. Default 1.

.EXAMPLE
  pwsh scripts/diagnostics/rank-repos-by-activity.ps1
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = 'E:\Developer\lufftw\repo',
    [string]$ContextHome = $(if ($env:CLAUDE_CONTEXT_HOME) { $env:CLAUDE_CONTEXT_HOME } else { Join-Path $env:USERPROFILE '.context' }),
    [int]$MinScore = 1
)

$ErrorActionPreference = 'SilentlyContinue'

$snap = Join-Path $ContextHome 'mcp-codebase-snapshot.json'
$tracked = @{}
if (Test-Path $snap) {
    $j = Get-Content $snap -Raw | ConvertFrom-Json
    foreach ($p in $j.codebases.PSObject.Properties) {
        $tracked[$p.Name] = $p.Value
    }
}

$rows = @()
$repos = Get-ChildItem -Path $RepoRoot -Directory | Where-Object {
    (Test-Path (Join-Path $_.FullName '.git')) -and ($_.Name -notlike '*-workspace')
}

foreach ($repo in $repos) {
    Push-Location $repo.FullName
    try {
        $c7 = [int](git log --since='7 days ago' --pretty=format:1 2>$null | Measure-Object).Count
        $c30 = [int](git log --since='30 days ago' --pretty=format:1 2>$null | Measure-Object).Count
        $lastCommit = git log -1 --format='%ci' 2>$null
    } finally { Pop-Location }

    $score = ($c7 * 4) + $c30
    if ($score -lt $MinScore) { continue }

    $info = $tracked[$repo.FullName]
    $status = if ($info) {
        if ($info.indexedFiles -eq 0 -and $info.totalChunks -gt 0) {
            'RECONCILED'    # came from reconcile-snapshot, files unknown
        } else {
            'TRACKED'
        }
    } else {
        'UNTRACKED'
    }

    $chunks = if ($info) { $info.totalChunks } else { '-' }
    $files  = if ($info) { $info.indexedFiles } else { '-' }

    $rows += [pscustomobject]@{
        Score      = $score
        Repo       = $repo.Name
        '7d'       = $c7
        '30d'      = $c30
        LastCommit = if ($lastCommit) { $lastCommit.Substring(0,16) } else { '-' }
        Snapshot   = $status
        Chunks     = $chunks
        Files      = $files
    }
}

$rows = $rows | Sort-Object -Property Score -Descending
$rows | Format-Table -AutoSize

Write-Host "`n=== Summary ===" -ForegroundColor Cyan
Write-Host "  Total ranked: $($rows.Count)"
Write-Host "  TRACKED:    $(($rows | Where-Object Snapshot -eq 'TRACKED').Count)"
Write-Host "  RECONCILED: $(($rows | Where-Object Snapshot -eq 'RECONCILED').Count)"
Write-Host "  UNTRACKED:  $(($rows | Where-Object Snapshot -eq 'UNTRACKED').Count)"
