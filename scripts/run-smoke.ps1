#!/usr/bin/env pwsh
# Smoke harness wrapper.
# - Acquires exclusive lock to enforce one-task-at-a-time execution per Plan v5 Forbidden Actions.
# - Restores snapshot from backup before each run so BASELINE numbers in snapshot-smoke.mjs hold.
# - Sources the appropriate env script (default OpenAI; -RabbitMQ for RabbitMQ mode).
# Exit codes: 50 = lock held by another runner; 51 = backup missing; 0 = all smokes passed; >0 = first-failing smoke's exit code.

param([switch]$RabbitMQ)

$smokeHome = 'E:\tmp\upgrade-smoke-context'
New-Item -ItemType Directory -Force -Path $smokeHome | Out-Null
$lockPath = Join-Path $smokeHome '.lock'

# Exclusive file lock via FileShare::None.
$lockFs = $null
try {
    $lockFs = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
} catch {
    Write-Error "Another smoke run holds the lock at $lockPath. One-task-at-a-time execution required."
    exit 50
}

try {
    $envScript = if ($RabbitMQ) { Join-Path $PSScriptRoot 'smoke-env-rabbitmq.ps1' } else { Join-Path $PSScriptRoot 'smoke-env.ps1' }
    . $envScript

    # Restore snapshot from backup at every run.
    $bkRel = Join-Path (Split-Path $PSScriptRoot -Parent) 'backups\snapshot-2026-05-06-pre-phase-b.json'
    $bk = if (Test-Path $bkRel) { (Resolve-Path $bkRel).Path } elseif ($env:UPGRADE_BACKUP_PATH -and (Test-Path $env:UPGRADE_BACKUP_PATH)) { (Resolve-Path $env:UPGRADE_BACKUP_PATH).Path } else { $null }
    if (-not $bk) { Write-Error "Backup snapshot not found (looked at $bkRel and `$env:UPGRADE_BACKUP_PATH)"; exit 51 }
    Copy-Item $bk (Join-Path $env:CLAUDE_CONTEXT_HOME 'mcp-codebase-snapshot.json') -Force

    $repoRoot = Split-Path $PSScriptRoot -Parent
    $inv = New-TemporaryFile
    $env:SMOKE_INVENTORY_OUT = $inv.FullName

    & node (Join-Path $repoRoot 'packages\mcp\scripts\jsonrpc-smoke.mjs')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node (Join-Path $repoRoot 'packages\mcp\scripts\snapshot-smoke.mjs')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node (Join-Path $repoRoot 'packages\mcp\scripts\feature-regression.mjs')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    # Emit tools inventory for manifest log column.
    Get-Content $inv.FullName

    Remove-Item $inv.FullName -ErrorAction SilentlyContinue
} finally {
    if ($lockFs) { $lockFs.Close(); $lockFs.Dispose() }
    Remove-Item $lockPath -ErrorAction SilentlyContinue
}
