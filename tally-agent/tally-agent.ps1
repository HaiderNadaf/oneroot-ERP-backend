<#
  OneRoot ERP -> Tally Prime sync agent.

  Runs on the Tally server (Windows Task Scheduler, every minute). Each run:
    1. checks Tally Prime is running on this machine (port 9000),
    2. asks the ERP for the next documents (POs, GRNs, sales, bills, payments ...) as Tally XML,
    3. imports each one into Tally through http://localhost:9000, in order,
    4. tells the ERP what Tally said, so the ERP's "Tally Sync" screen shows done / failed,
    5. when the ERP's Tally page asks, reads Tally's vouchers and sends them up.

  Only outgoing connections: to the ERP over HTTPS and to Tally on this machine. Nothing is opened to the internet.
  Settings are in tally-agent.config.json next to this script. Works with Windows PowerShell 5.1.
#>

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Get-Content -Raw -Encoding UTF8 (Join-Path $here 'tally-agent.config.json') | ConvertFrom-Json
$erp = $config.ErpUrl.TrimEnd('/')
$tally = if ($config.TallyUrl) { $config.TallyUrl } else { 'http://localhost:9000' }
$batch = if ($config.BatchSize) { [int]$config.BatchSize } else { 20 }
$logFile = Join-Path $here 'tally-agent.log'
# Jobs Tally accepted: if telling the ERP fails, the next run reports them again instead of importing twice
$doneFile = Join-Path $here 'tally-agent-done.txt'

function Log([string]$text) {
  if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 5MB) { Move-Item $logFile "$logFile.old" -Force }
  Add-Content -Path $logFile -Encoding UTF8 -Value ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $text)
}

# One run at a time, even if the scheduler starts the next before this one ends
$mutex = New-Object System.Threading.Mutex($false, 'Global\OneRootTallyAgent')
if (-not $mutex.WaitOne(0)) { exit 0 }

function Erp([string]$method, [string]$path, $body) {
  $headers = @{ 'x-tally-agent-token' = $config.Token }
  if ($null -eq $body) {
    return Invoke-RestMethod -Method $method -Uri "$erp$path" -Headers $headers -TimeoutSec 60
  }
  $json = [System.Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Compress -Depth 5))
  return Invoke-RestMethod -Method $method -Uri "$erp$path" -Headers $headers -Body $json -ContentType 'application/json; charset=utf-8' -TimeoutSec 300
}

function Tally([string]$xml) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($xml)
  $r = Invoke-WebRequest -Method Post -Uri $tally -Body $bytes -ContentType 'text/xml; charset=utf-8' -UseBasicParsing -TimeoutSec 300
  # Decode the bytes ourselves: Tally may answer in UTF-16 or UTF-8 without saying which
  $raw = $r.RawContentStream.ToArray()
  if ($raw.Length -ge 2 -and $raw[0] -eq 0xFF -and $raw[1] -eq 0xFE) { return [System.Text.Encoding]::Unicode.GetString($raw, 2, $raw.Length - 2) }
  if ($raw.Length -ge 2 -and $raw[1] -eq 0x00) { return [System.Text.Encoding]::Unicode.GetString($raw) }
  return [System.Text.Encoding]::UTF8.GetString($raw)
}

function Count([string]$text, [string]$tag) {
  $m = [regex]::Match($text, "<$tag>\s*(-?\d+)\s*</$tag>")
  if ($m.Success) { return [int]$m.Groups[1].Value } else { return 0 }
}

function LineErrors([string]$text) {
  return @([regex]::Matches($text, '<LINEERROR>(.*?)</LINEERROR>', 'Singleline') | ForEach-Object { $_.Groups[1].Value.Trim() })
}

# Tally closed or the company not open: not the document's fault, so it is tried again later in its place
function IsTransient([string]$text) {
  return ($text -match '(?i)company' -and $text -match '(?i)(not (open|loaded|found|exist)|does not exist|no company)')
}

function Report($id, $result) {
  try { Erp 'POST' "/tally-agent/result/$id" $result | Out-Null; return $true }
  catch { Log "  could not report job $id to the ERP: $($_.Exception.Message)"; return $false }
}

try {
  # 1. Tally running?
  try { Invoke-WebRequest -Uri $tally -UseBasicParsing -TimeoutSec 10 | Out-Null }
  catch { exit 0 }  # Tally Prime is closed: try again next minute

  # Jobs Tally already took whose result never reached the ERP
  $done = @{}
  if (Test-Path $doneFile) {
    foreach ($line in Get-Content $doneFile) { if ($line -match '^\d+$') { $done[$line] = $true } }
  }
  foreach ($id in @($done.Keys)) {
    if (Report $id @{ ok = $true; mastersOk = $true; response = 'Imported earlier (agent log)' }) {
      (Get-Content $doneFile | Where-Object { $_ -ne $id }) | Set-Content $doneFile
    }
  }

  # 2. Next documents
  $next = Erp 'GET' "/tally-agent/next?limit=$batch" $null
  $jobs = @($next.jobs)
  if ($jobs.Count -eq 0 -and $null -eq $next.pull) { exit 0 }
  if ($jobs.Count -gt 0) { Log "Got $($jobs.Count) job(s) for company '$($next.company)'" }

  foreach ($job in $jobs) {
    $id = [string]$job.id
    if ($done.ContainsKey($id)) {
      Log "  #$id $($job.label): already in Tally, reporting again"
      Report $id @{ ok = $true; mastersOk = $true; response = 'Imported earlier (agent log)' } | Out-Null
      continue
    }

    $mastersOk = $true
    $result = $null
    $responses = @()
    foreach ($part in @($job.parts)) {
      try { $text = Tally $part.xml }
      catch {
        $result = @{ ok = $false; transient = $true; error = "Tally not reachable: $($_.Exception.Message)" }
        break
      }
      $responses += $text
      $errors = (Count $text 'ERRORS') + (Count $text 'EXCEPTIONS')
      $lineErrors = LineErrors $text

      if ($part.kind -eq 'masters') {
        # A ledger / item / unit that is already in Tally is fine: the voucher uses it as it is
        $real = @($lineErrors | Where-Object { $_ -notmatch '(?i)already exists|duplicate' })
        if ($real.Count -gt 0 -or ($errors -gt 0 -and $lineErrors.Count -eq 0)) {
          $mastersOk = $false
          $msg = if ($real.Count) { $real -join ' | ' } else { "Tally reported $errors error(s) creating masters" }
          $result = @{ ok = $false; mastersOk = $false; transient = (IsTransient $text); error = "Masters: $msg" }
          break
        }
        continue
      }

      $accepted = (Count $text 'CREATED') + (Count $text 'ALTERED') + (Count $text 'CANCELLED') + (Count $text 'COMBINED')
      if ($errors -gt 0 -or $accepted -eq 0) {
        $msg = if ($lineErrors.Count) { $lineErrors -join ' | ' } elseif ($accepted -eq 0) { 'Tally did not create anything' } else { "Tally reported $errors error(s)" }
        $result = @{ ok = $false; mastersOk = $mastersOk; transient = (IsTransient $text); error = $msg }
        break
      }
    }
    if ($null -eq $result) { $result = @{ ok = $true; mastersOk = $true } }
    $result.response = (($responses -join "`n") -replace '\s+', ' ')
    if ($result.response.Length -gt 15000) { $result.response = $result.response.Substring(0, 15000) }

    if ($result.ok) {
      Add-Content -Path $doneFile -Value $id
      Log "  #$id $($job.label): OK"
    } else {
      Log "  #$id $($job.label): $(if ($result.transient) { 'WILL RETRY' } else { 'FAILED' }) - $($result.error)"
    }
    $reported = Report $id $result
    if ($result.ok -and $reported) {
      # Keep the done list short: only jobs whose result is still unconfirmed need to stay
      (Get-Content $doneFile | Where-Object { $_ -ne $id }) | Set-Content $doneFile
    }
    # Tally went away mid-run: stop here so the remaining jobs keep their order
    if ($result.transient) { break }
  }

  # 5. The ERP's Tally page asked for Tally's vouchers: run the export it sent and hand back Tally's reply as it is
  if ($null -ne $next.pull) {
    $pull = $next.pull
    $answer = @{ from = $pull.from; to = $pull.to }
    try { $answer.xml = Tally $pull.request }
    catch { $answer.error = "Tally not reachable: $($_.Exception.Message)" }
    try {
      Erp 'POST' '/tally-agent/vouchers' $answer | Out-Null
      Log "Read Tally vouchers $($pull.from) to $($pull.to)$(if ($answer.error) { ': ' + $answer.error })"
    }
    catch { Log "Could not send Tally's vouchers to the ERP: $($_.Exception.Message)" }
  }
}
catch {
  Log "Run failed: $($_.Exception.Message)"
  exit 1
}
finally {
  $mutex.ReleaseMutex()
}
