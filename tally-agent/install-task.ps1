<#
  Registers the OneRoot -> Tally sync to run every minute. Run once, as Administrator, from this folder:
    powershell -ExecutionPolicy Bypass -File .\install-task.ps1
  To remove it later:  schtasks /Delete /TN "OneRoot Tally Sync" /F
#>
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'tally-agent.ps1'
if (-not (Test-Path (Join-Path $here 'tally-agent.config.json'))) {
  throw 'Copy tally-agent.config.example.json to tally-agent.config.json and fill in ErpUrl and Token first.'
}
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'OneRoot Tally Sync' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host 'Installed: "OneRoot Tally Sync" runs every minute. Log: tally-agent.log in this folder.'
