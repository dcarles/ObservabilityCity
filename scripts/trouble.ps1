<#
.SYNOPSIS
  Ready-made trouble for the fake data source, until the Break things panel exists.
.EXAMPLE
  ./scripts/trouble.ps1 list                       # show the presets
  ./scripts/trouble.ps1 high-cpu                   # one preset
  ./scripts/trouble.ps1 dlq-buildup, down          # several, they stack
  ./scripts/trouble.ps1 reset                      # clear everything
  ./scripts/trouble.ps1 raw cl.ledger-api Errors 0.5
  ./scripts/trouble.ps1 -BaseUrl http://localhost:5080 bad-day
  ./scripts/trouble.ps1 -Env staging tenant-unknown   # aim at one environment (default: the server's default, prod in the sample town)
#>
param(
  [Parameter(Position = 0, ValueFromRemainingArguments = $true)][string[]]$Preset = @('list'),
  [string]$BaseUrl = 'http://localhost:5080',
  [Alias('Env')][string]$Environment = ''
)
$ErrorActionPreference = 'Stop'

# Each preset is a list of @(target, kind, intensity). Targets are system ids or a pillar id (the whole island).
$presets = [ordered]@{
  'high-cpu'     = @(, @('cl.ledger-api', 'HighCpu', 0.9))
  'slow-api'     = @(, @('cl.ledger-api', 'Latency', 0.8))
  'errors'       = @(, @('pay.payments-api', 'Errors', 0.8))
  'sick'         = @(, @('pay.payments-api', 'UnhealthyInstances', 0.5))
  'leak'         = @(, @('cl.ledger-worker', 'HighMemory', 1))
  'db-throttle'  = @(, @('cl.ledger-db', 'Saturate', 1))
  'backlog'      = @(, @('pay.payments-worker', 'Backlog', 1))
  'dlq-buildup'  = @(, @('pay.payments-worker', 'Poison', 1))
  'down'         = @(, @('cl.ledger-api', 'Down', 1))
  'stale'        = @(, @('frd.screening-api', 'Stale', 1))
  'traffic'      = @(, @('*', 'Traffic', 0.6))
  'rain'         = @(, @('pay', 'Incident', 0.6))
  'storm'        = @(, @('cl', 'Incident', 0.9))
  'overcast'     = @(, @('frd', 'Incident', 0.4))
  'clouds'       = @(, @('dat', 'Incident', 0.1))
  'incident-storm' = @(@('pay', 'Incident', 0.9), @('cl', 'Incident', 0.6), @('frd', 'Incident', 0.4))
  'vendor-down'  = @(, @('ext.credit-bureau', 'Down', 1))
  'vendor-slow'  = @(, @('ext.card-network', 'Latency', 0.9))
  'vendor-errors' = @(, @('ext.sms-email', 'Errors', 0.7))
  'airport-rush' = @(, @('hub.apim', 'Traffic', 0.9))
  'stale-island' = @(, @('frd', 'Stale', 1))
  'pier-backlog' = @(, @('rcn.matching-worker', 'Backlog', 1))
  'pier-dlq'     = @(, @('rcn.matching-worker', 'Poison', 1))
  'legacy-dlq'   = @(, @('lost-found.batch-gateway-worker', 'Poison', 1))
  'dlq-everywhere' = @(@('rcn.matching-worker', 'Poison', 1), @('pay.payments-worker', 'Poison', 1), @('cl.ledger-worker', 'Poison', 0.6), @('lost-found.batch-gateway-worker', 'Poison', 0.4))
  # a database with a database for each tenant: aim at one tenant with store#tenant (prod tenants; zeta-trading is the staging tenant nobody listed)
  'tenant-throttle' = @(, @('cl.ledger-db#acme-bank', 'Saturate', 1))
  'tenant-throttle-test' = @(, @('cl.ledger-db#smoke-prod', 'Saturate', 1))
  'tenant-throttle-all' = @(@('cl.ledger-db#acme-bank', 'Saturate', 1), @('cl.ledger-db#borealis-credit', 'Saturate', 0.8), @('cl.ledger-db#cygnus-finance', 'Saturate', 0.6))
  'tenant-unknown' = @(, @('cl.ledger-db#zeta-trading', 'Saturate', 1))
  'bad-day'      = @(@('pay', 'Errors', 0.6), @('pay', 'Latency', 0.7), @('pay.payments-worker', 'Poison', 1), @('cl.ledger-db', 'Saturate', 0.8))
}

function Send($method, $path, $body) {
  $query = if ($Environment) { "?env=$([uri]::EscapeDataString($Environment))" } else { '' }
  $req = @{ Method = $method; Uri = "$BaseUrl/api/fake$path$query"; ErrorAction = 'Stop' }
  if ($body) { $req.Body = ($body | ConvertTo-Json); $req.ContentType = 'application/json' }
  try { Invoke-RestMethod @req } catch { throw "Cannot reach $BaseUrl (is the backend running?): $($_.Exception.Message)" }
}

if ($Preset[0] -eq 'raw') {
  if ($Preset.Count -lt 3) { throw 'usage: trouble.ps1 raw <target> <kind> [intensity]' }
  $i = if ($Preset.Count -gt 3) { [double]$Preset[3] } else { 1 }
  Send Post '/effects' @{ target = $Preset[1]; kind = $Preset[2]; intensity = $i } | Out-Null
  Write-Host "$($Preset[2]) on $($Preset[1])"
  return
}

foreach ($name in $Preset) {
  switch ($name) {
    'list' {
      $presets.GetEnumerator() | ForEach-Object { '{0,-14} {1}' -f $_.Key, (($_.Value | ForEach-Object { "$($_[1]) $($_[0])" }) -join ', ') }
      'reset         clears every effect and the backlog and dead letters they left'
      'calm          freezes the noise and the daily cycle (calm-off to undo)'
      'raw           raw <target> <kind> [intensity]; kinds: Traffic Errors Latency UnhealthyInstances Down HighCpu HighMemory Saturate Backlog Poison Stale Incident (Saturate can name one tenant: raw cl.ledger-db#acme-bank Saturate; severity from intensity; third parties take the same effects as any system)'
    }
    'reset' { Send Post '/reset' $null | Out-Null; Write-Host 'Reset to a calm baseline' }
    'calm' { Send Post '/calm' @{ on = $true } | Out-Null; Write-Host 'Calm on' }
    'calm-off' { Send Post '/calm' @{ on = $false } | Out-Null; Write-Host 'Calm off' }
    default {
      if (-not $presets.Contains($name)) { throw "Unknown preset '$name'. Run: trouble.ps1 list" }
      foreach ($e in $presets[$name]) {
        Send Post '/effects' @{ target = $e[0]; kind = $e[1]; intensity = $e[2] } | Out-Null
        Write-Host "$name : $($e[1]) on $($e[0]) ($($e[2]))"
      }
    }
  }
}
