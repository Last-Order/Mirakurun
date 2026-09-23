# Run from the new source checkout, in an elevated PowerShell session.
[CmdletBinding()]
param([string]$ServiceName = 'mirakurun')
$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from an elevated PowerShell session.'
}
$parameters = Get-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters"
if ($parameters.AppParameters -notmatch 'bin[\\/]init\.win32\.js') {
    throw 'Service does not use bin/init.win32.js. Check its custom startup configuration before migrating.'
}
$installation = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($parameters.AppDirectory))
$targetBin = Join-Path $installation 'bin'
$files = @('init.win32.js', 'daily-logs.js')
foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $file) -PathType Leaf)) {
        throw "Missing source file: $file"
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $targetBin 'init.win32.js') -PathType Leaf)) {
    throw "Not a Windows Mirakurun installation: $installation"
}
if ([IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') -ieq $targetBin.TrimEnd('\')) {
    throw 'Run the migration from a separate new source checkout, not the installed service directory.'
}

$service = Get-Service -Name $ServiceName
$wasRunning = $service.Status -eq 'Running'
$backup = Join-Path $installation ('log-migration-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $backup | Out-Null
foreach ($file in $files) {
    $existing = Join-Path $targetBin $file
    if (Test-Path -LiteralPath $existing) {
        Copy-Item -LiteralPath $existing -Destination (Join-Path $backup $file)
    }
}
Write-Output "Installation: $installation"
Write-Output "Backup: $backup"
try {
    if ($service.Status -ne 'Stopped') {
        Stop-Service -Name $ServiceName
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
    }
    foreach ($file in $files) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $targetBin $file) -Force
    }
    if ($wasRunning) {
        Start-Service -Name $ServiceName
        (Get-Service -Name $ServiceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(60))
    }
} catch {
    Write-Warning "Migration failed. Backup: $backup. See doc/Windows-Logging.md for rollback steps."
    throw
}
Write-Output 'Migration copied both files. Service registry settings and old logs were preserved.'
Write-Output 'Verify the dated logs and HTTP status as described in doc/Windows-Logging.md.'
if (-not $wasRunning) { Write-Output 'The service was stopped before migration and remains stopped.' }
