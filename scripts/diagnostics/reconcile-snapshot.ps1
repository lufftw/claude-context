<#
.SYNOPSIS
  Reconcile the shared snapshot with the actual state of Milvus collections.
  For each `*_own` collection in Milvus that has rows but is NOT tracked in
  the snapshot, attempt to map it back to a real repo on disk and register
  the entry with the row count from Milvus and a placeholder file count.

.DESCRIPTION
  Background: the v0.1.3-lufftw.2 snapshot fix had two regressions (lock
  never engaged + load did not enroll missing paths in removedCodebases)
  that caused silent loss of snapshot entries when multiple MCP processes
  contended for the file. The Milvus collections themselves were unaffected
  (Milvus has its own persistence), but the snapshot tracking was lost.

  This script doesn't reach into the MCP's in-memory state — it edits the
  snapshot JSON directly. The chunk count comes from Milvus's row count;
  the file count is unknown and reported as 0 (will be corrected on next
  reindexByChange in the background sync).

  Run AFTER all MCP sessions have been restarted with the lock fix.
  Otherwise stale MCPs may immediately undo the registration.

.PARAMETER MilvusAddress
  Default: http://127.0.0.1:19530

.PARAMETER MilvusToken
  Default: read from .mcp.json env block.

.PARAMETER ContextHome
  Default: $env:CLAUDE_CONTEXT_HOME or ~/.context.

.PARAMETER WhatIf
  Print intended changes without writing.

.EXAMPLE
  pwsh scripts/diagnostics/reconcile-snapshot.ps1 -WhatIf
.EXAMPLE
  pwsh scripts/diagnostics/reconcile-snapshot.ps1 -ContextHome E:/Developer/lufftw/repo/claude-control-center/mcp/61server/share/claude-context/.context
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$MilvusAddress = 'http://127.0.0.1:19530',
    [string]$MilvusToken,
    [string]$ContextHome = $(if ($env:CLAUDE_CONTEXT_HOME) { $env:CLAUDE_CONTEXT_HOME } else { Join-Path $env:USERPROFILE '.context' }),
    [string]$RepoRoot = 'E:\Developer\lufftw\repo'
)

# Resolve token if not given
if (-not $MilvusToken) {
    $mcpJson = Join-Path $PSScriptRoot '..\..\..\mcp-services\.mcp.json'
    if (Test-Path $mcpJson) {
        $cfg = Get-Content $mcpJson -Raw | ConvertFrom-Json
        $srv = $cfg.mcpServers.PSObject.Properties | Where-Object { $_.Name -like 'claude-context*' } | Select-Object -First 1
        if ($srv) { $MilvusToken = $srv.Value.env.MILVUS_TOKEN }
    }
    if (-not $MilvusToken) { throw 'MilvusToken not provided and could not be resolved from .mcp.json' }
}

$snap = Join-Path $ContextHome 'mcp-codebase-snapshot.json'
if (-not (Test-Path $snap)) { throw "No snapshot at $snap" }

$j = Get-Content $snap -Raw | ConvertFrom-Json
$tracked = @{}
foreach ($p in $j.codebases.PSObject.Properties) { $tracked[$p.Name] = $true }

# Fetch Milvus collections + row counts
$headers = @{ Authorization = "Bearer $MilvusToken"; 'Content-Type' = 'application/json' }
$colls = (Invoke-RestMethod -Uri "$MilvusAddress/v1/vector/collections" -UseBasicParsing -TimeoutSec 5 -Headers $headers).data

$registered = @()
$skipped = @()
$truly_stale = @()

foreach ($coll in $colls) {
    if ($coll -notmatch '_own$') { continue }  # skip *_shared, *_docs

    # Get row count
    $body = @{ collectionName = $coll; dbName = 'default' } | ConvertTo-Json
    try {
        $stats = Invoke-RestMethod -Uri "$MilvusAddress/v2/vectordb/collections/get_stats" -Method Post -Headers $headers -Body $body -TimeoutSec 5
        $rows = [int]$stats.data.rowCount
    } catch { $rows = 0 }
    if ($rows -le 0) { continue }

    # Heuristic: snake_case -> kebab-case -> repo path. Brittle when projects
    # have been renamed (e.g. poi_crawler_worker_own actually belongs to
    # poi-data-layer-crawler-worker). We confirm by sampling collection content
    # below before registering.
    $kebab = $coll -replace '_own$','' -replace '_workspace_own','-workspace' -replace '_','-'
    $heuristicPath = Join-Path $RepoRoot $kebab

    # Sample 5 relativePath values from the collection and check how many
    # exist on disk under the heuristic path. Reject the heuristic if it
    # gets fewer than half its samples right (likely renamed project).
    $sampleBody = @{
        collectionName = $coll; dbName = 'default'; limit = 5;
        outputFields = @('relativePath')
    } | ConvertTo-Json
    $samples = @()
    try {
        $sampleResp = Invoke-RestMethod -Uri "$MilvusAddress/v2/vectordb/entities/query" -Method Post -Headers $headers -Body $sampleBody -TimeoutSec 5
        $samples = @($sampleResp.data | ForEach-Object { $_.relativePath })
    } catch { }

    function Test-Match($candidate, $samples) {
        if (-not (Test-Path $candidate)) { return 0 }
        $hits = 0
        foreach ($rel in $samples) {
            $norm = $rel -replace '\\','/'
            if (Test-Path (Join-Path $candidate $norm)) { $hits++ }
        }
        return $hits
    }

    $repoPath = $null
    # Resolution order:
    #   (1) heuristic path exists AND any sample matches there -> use it (cheapest, highest precedence)
    #   (2) heuristic path exists but no samples checked / matched -> use it (might be re-renamed but
    #       still likely; user can inspect)
    #   (3) heuristic path does NOT exist -> search all repos under $RepoRoot for the best content match
    if (Test-Path $heuristicPath) {
        $repoPath = $heuristicPath
    } elseif ($samples.Count -gt 0) {
        # Heuristic path is gone — search by content to handle renamed projects.
        $candidates = Get-ChildItem -Path $RepoRoot -Directory -ErrorAction SilentlyContinue
        $best = $null; $bestHits = 0
        foreach ($c in $candidates) {
            $hits = Test-Match $c.FullName $samples
            if ($hits -gt $bestHits) { $bestHits = $hits; $best = $c.FullName }
        }
        # Require at least half the samples to match before trusting the resolution.
        if ($best -and $bestHits -ge ([Math]::Ceiling($samples.Count / 2.0))) {
            $repoPath = $best
            Write-Host "  [resolve] $coll : heuristic '$kebab' is gone; matched '$([System.IO.Path]::GetFileName($best))' by content ($bestHits/$($samples.Count) samples)" -ForegroundColor DarkYellow
        }
    }

    if (-not $repoPath) {
        $truly_stale += [pscustomobject]@{
            Collection = $coll; Rows = $rows;
            InferredPath = $heuristicPath;
            HeuristicHits = "$heuristicHits/$($samples.Count)"
        }
        continue
    }
    if ($tracked[$repoPath]) {
        $skipped += $coll
        continue
    }

    $entry = [pscustomobject]@{
        status = 'indexed'
        indexedFiles = 0  # Unknown; will be corrected by next reindexByChange
        totalChunks = $rows
        indexStatus = 'completed'
        lastUpdated = (Get-Date -Format 'o')
    }
    $registered += [pscustomobject]@{ Collection = $coll; Path = $repoPath; Rows = $rows }

    if ($PSCmdlet.ShouldProcess($repoPath, "Register $coll ($rows rows) into snapshot")) {
        $j.codebases | Add-Member -MemberType NoteProperty -Name $repoPath -Value $entry -Force
    }
}

Write-Host "`n=== Reconciliation summary ===" -ForegroundColor Cyan
Write-Host "  Already tracked: $($skipped.Count)"
Write-Host "  Registered now:  $($registered.Count)" -ForegroundColor $(if ($registered.Count -gt 0) { 'Green' } else { 'Gray' })
$registered | Format-Table -AutoSize
Write-Host "  Truly stale (collection has no matching repo on disk):" -ForegroundColor Yellow
$truly_stale | Format-Table -AutoSize
if ($truly_stale.Count -gt 0) {
    Write-Host "  -> Drop these collections only if you are SURE the project is gone."
    Write-Host "     Drop command (Milvus REST):"
    foreach ($t in $truly_stale) {
        Write-Host "       curl -X POST $MilvusAddress/v2/vectordb/collections/drop -H 'Authorization: Bearer $MilvusToken' -H 'Content-Type: application/json' -d '{`"collectionName`":`"$($t.Collection)`",`"dbName`":`"default`"}'"
    }
}

if ($PSCmdlet.ShouldProcess($snap, 'Write reconciled snapshot') -and $registered.Count -gt 0) {
    $j.lastUpdated = (Get-Date -Format 'o')
    $j | ConvertTo-Json -Depth 10 | Set-Content -Path $snap -Encoding UTF8
    Write-Host "`nWrote reconciled snapshot. $($j.codebases.PSObject.Properties.Count) entries total." -ForegroundColor Green
} elseif (-not $PSCmdlet.ShouldProcess($snap, 'Write')) {
    Write-Host "`n(WhatIf mode — no file written)" -ForegroundColor Yellow
}
