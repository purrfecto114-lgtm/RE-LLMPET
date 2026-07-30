[CmdletBinding()]
param(
  [string]$WorkingDirectory = $HOME,
  [string]$OutputPath = (Join-Path $PWD 'octopus-cli-diagnostics.json')
)
$ErrorActionPreference = 'Stop'

function Protect-DiagnosticText {
  param([string]$Text)
  if ($null -eq $Text) { return '' }
  $protected = @()
  foreach ($line in ($Text -split "`r?`n")) {
    if ($line -match '(?i)(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]') {
      $protected += [regex]::Replace($line, '(?i)^(.{0,240}?(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]).*$', '$1 ***')
    } else {
      $safe = [regex]::Replace($line, '(?i)\b(?:sk[-_][A-Za-z0-9_-]{8,}|ds-[A-Za-z0-9_-]{8,}|bearer\s+[A-Za-z0-9._~+/-]{8,})', '***')
      $protected += $safe
    }
  }
  return ($protected -join "`n")
}

function Read-BoundedText {
  param([string]$Path, [int]$Limit = 8192)
  $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue
  if ($null -eq $raw) { $raw = '' }
  if ($raw.Length -gt 16384) { $raw = $raw.Substring(0, 16384) }
  $raw = Protect-DiagnosticText -Text $raw
  if ($raw.Length -gt $Limit) { return $raw.Substring(0, $Limit) }
  return $raw
}

function ConvertTo-CmdQuotedArgument {
  param([string]$Value)
  return '"' + $Value.Replace('"', '""') + '"'
}

function Test-UnknownCommandProbe {
  param($Probe)
  if ($null -eq $Probe) { return $false }
  $text = (([string]$Probe.stdout) + "`n" + ([string]$Probe.stderr) + "`n" + ([string]$Probe.error)).ToLowerInvariant()
  foreach ($needle in @(
    'unknown command',
    'unknown subcommand',
    'unrecognized subcommand',
    'invalid subcommand',
    "unexpected argument 'doctor'",
    'unexpected argument "doctor"',
    "found argument 'doctor' which wasn't expected",
    'found argument "doctor" which wasn''t expected'
  )) {
    if ($text.Contains($needle)) { return $true }
  }
  return $false
}

function Test-ParseableJsonProbe {
  param($Probe)
  if ($null -eq $Probe) { return $false }
  foreach ($candidate in @([string]$Probe.stdout, [string]$Probe.stderr)) {
    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
    try {
      $null = $candidate | ConvertFrom-Json -ErrorAction Stop
      return $true
    } catch { }
  }
  return $false
}

function Invoke-BoundedProbe {
  param([string]$Exe, [string[]]$Arguments, [int]$TimeoutSeconds = 15)
  $stdout = [IO.Path]::GetTempFileName()
  $stderr = [IO.Path]::GetTempFileName()
  try {
    $extension = [IO.Path]::GetExtension($Exe)
    if ($extension -ieq '.cmd' -or $extension -ieq '.bat') {
      $parts = @('call ' + (ConvertTo-CmdQuotedArgument -Value $Exe))
      foreach ($argument in $Arguments) {
        $parts += ConvertTo-CmdQuotedArgument -Value $argument
      }
      $filePath = $env:ComSpec
      if (-not $filePath) { $filePath = 'cmd.exe' }
      $argumentList = @('/D', '/S', '/C', ($parts -join ' '))
    } else {
      $filePath = $Exe
      $argumentList = $Arguments
    }

    try {
      $p = Start-Process -FilePath $filePath -ArgumentList $argumentList -WorkingDirectory $WorkingDirectory -NoNewWindow -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    } catch {
      return [ordered]@{
        started = $false
        success = $false
        exitCode = $null
        timedOut = $false
        stdout = Read-BoundedText -Path $stdout
        stderr = Read-BoundedText -Path $stderr
        error = $_.Exception.Message
      }
    }

    if (-not $p.WaitForExit($TimeoutSeconds * 1000)) {
      try { $p.Kill() } catch { }
      $timedOut = $true
    } else {
      $timedOut = $false
    }
    return [ordered]@{
      started = $true
      success = (-not $timedOut -and $p.ExitCode -eq 0)
      exitCode = if ($timedOut) { $null } else { $p.ExitCode }
      timedOut = $timedOut
      stdout = Read-BoundedText -Path $stdout
      stderr = Read-BoundedText -Path $stderr
      error = $null
    }
  } finally {
    Remove-Item $stdout,$stderr -Force -ErrorAction SilentlyContinue
  }
}

$resolvedWorkingDirectory = Resolve-Path -LiteralPath $WorkingDirectory -ErrorAction Stop
$agents = [ordered]@{}
foreach ($name in 'claude','codewhale','codewhale-tui','codex','opencode','aider') {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
  $agents[$name] = [ordered]@{
    found = [bool]$cmd
    source = if ($cmd) { $cmd.Source } else { $null }
    commandType = if ($cmd) { [string]$cmd.CommandType } else { $null }
    version = if ($cmd) { Invoke-BoundedProbe -Exe $cmd.Source -Arguments @('--version') -TimeoutSeconds 8 } else { $null }
  }
}

$codewhaleDoctor = $null
$codewhaleDoctorTarget = $null
$codewhaleDoctorSurface = $null
$codewhaleDoctorAttempts = @()
# R10 (2026-07-30): probe the matched codewhale-tui companion FIRST.
# See docs/MIGRATION_R10_CODEWHALE_DOCTOR_ORDER_2026-07-30.md for the decision
# record and the web cross-validation caveat. The dispatcher is the fallback.
if ($agents['codewhale-tui'].found) {
  $companionProbe = Invoke-BoundedProbe -Exe $agents['codewhale-tui'].source -Arguments @('doctor','--json') -TimeoutSeconds 20
  $codewhaleDoctorAttempts += [ordered]@{
    surface = 'companion'
    target = $agents['codewhale-tui'].source
    parseableJson = Test-ParseableJsonProbe -Probe $companionProbe
    probe = $companionProbe
  }
  $codewhaleDoctor = $companionProbe
  $codewhaleDoctorTarget = $agents['codewhale-tui'].source
  $codewhaleDoctorSurface = 'companion'
}
$companionIsDefinitive = ($null -ne $codewhaleDoctor) -and ((Test-ParseableJsonProbe -Probe $codewhaleDoctor) -or $codewhaleDoctor.success)
$needsDispatcherDoctor = -not $companionIsDefinitive
if ($needsDispatcherDoctor -and $agents['codewhale'].found) {
  $dispatcherProbe = Invoke-BoundedProbe -Exe $agents['codewhale'].source -Arguments @('doctor','--json') -TimeoutSeconds 20
  $codewhaleDoctorAttempts += [ordered]@{
    surface = 'dispatcher'
    target = $agents['codewhale'].source
    parseableJson = Test-ParseableJsonProbe -Probe $dispatcherProbe
    probe = $dispatcherProbe
  }
  $dispatcherIsBetter = (Test-ParseableJsonProbe -Probe $dispatcherProbe) -or $dispatcherProbe.success -or (($null -ne $codewhaleDoctor) -and (Test-UnknownCommandProbe -Probe $codewhaleDoctor))
  if ($dispatcherIsBetter) {
    $codewhaleDoctor = $dispatcherProbe
    $codewhaleDoctorTarget = $agents['codewhale'].source
    $codewhaleDoctorSurface = 'dispatcher'
  }
}
$claudeDoctor = $null
if ($agents['claude'].found) {
  $claudeDoctor = Invoke-BoundedProbe -Exe $agents['claude'].source -Arguments @('doctor') -TimeoutSeconds 20
}
$codewhaleAuth = $null
if ($agents['codewhale'].found) {
  $codewhaleAuth = Invoke-BoundedProbe -Exe $agents['codewhale'].source -Arguments @('auth','status') -TimeoutSeconds 12
}
$codexAuth = $null
if ($agents['codex'].found) {
  $codexAuth = Invoke-BoundedProbe -Exe $agents['codex'].source -Arguments @('login','status') -TimeoutSeconds 12
}
$opencodeAuth = $null
if ($agents['opencode'].found) {
  $opencodeAuth = Invoke-BoundedProbe -Exe $agents['opencode'].source -Arguments @('auth','list') -TimeoutSeconds 12
}
$aiderConfigCandidates = @(
  [ordered]@{ kind = 'working-directory'; path = (Join-Path $resolvedWorkingDirectory.Path '.aider.conf.yml'); present = (Test-Path -LiteralPath (Join-Path $resolvedWorkingDirectory.Path '.aider.conf.yml')) },
  [ordered]@{ kind = 'home'; path = (Join-Path $HOME '.aider.conf.yml'); present = (Test-Path -LiteralPath (Join-Path $HOME '.aider.conf.yml')) }
)
$aiderCredentialEnvironment = @()
foreach ($name in 'OPENAI_API_KEY','ANTHROPIC_API_KEY','DEEPSEEK_API_KEY','OPENROUTER_API_KEY','GEMINI_API_KEY','AZURE_API_KEY') {
  if (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
    $aiderCredentialEnvironment += $name
  }
}

$wt = Get-Command wt.exe -ErrorAction SilentlyContinue | Select-Object -First 1
$report = [ordered]@{
  generatedAt = (Get-Date).ToString('o')
  workingDirectory = $resolvedWorkingDirectory.Path
  windowsTerminal = if ($wt) { $wt.Source } else { $null }
  pathEntries = @($env:PATH -split ';' | Where-Object { $_ })
  agents = $agents
  claude = [ordered]@{
    doctor = $claudeDoctor
  }
  codex = [ordered]@{
    authentication = $codexAuth
  }
  opencode = [ordered]@{
    authentication = $opencodeAuth
    launchArguments = @('--dir','.')
  }
  aider = [ordered]@{
    configCandidates = $aiderConfigCandidates
    credentialEnvironment = $aiderCredentialEnvironment
    modelEnvironment = (-not [string]::IsNullOrWhiteSpace($env:AIDER_MODEL))
  }
  codewhale = [ordered]@{
    companionPairComplete = ($agents['codewhale'].found -and $agents['codewhale-tui'].found)
    configPath = if ($env:CODEWHALE_CONFIG_PATH) {
        $env:CODEWHALE_CONFIG_PATH
    } elseif ($env:DEEPSEEK_CONFIG_PATH) {
        $env:DEEPSEEK_CONFIG_PATH
    } elseif ($env:CODEWHALE_HOME) {
        Join-Path $env:CODEWHALE_HOME 'config.toml'
    } elseif (Test-Path -LiteralPath (Join-Path $HOME '.codewhale\config.toml')) {
        Join-Path $HOME '.codewhale\config.toml'
    } elseif (Test-Path -LiteralPath (Join-Path $HOME '.deepseek\config.toml')) {
        Join-Path $HOME '.deepseek\config.toml'
    } else {
        Join-Path $HOME '.codewhale\config.toml'
    }
    projectOverlays = @(
      [ordered]@{ kind = 'current-project'; path = (Join-Path $resolvedWorkingDirectory.Path '.codewhale\config.toml'); present = (Test-Path -LiteralPath (Join-Path $resolvedWorkingDirectory.Path '.codewhale\config.toml')) },
      [ordered]@{ kind = 'legacy-project'; path = (Join-Path $resolvedWorkingDirectory.Path '.deepseek\config.toml'); present = (Test-Path -LiteralPath (Join-Path $resolvedWorkingDirectory.Path '.deepseek\config.toml')) }
    )
    doctor = $codewhaleDoctor
    doctorTarget = $codewhaleDoctorTarget
    doctorSurface = $codewhaleDoctorSurface
    doctorAttempts = $codewhaleDoctorAttempts
    authentication = $codewhaleAuth
  }
}

$report | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 $OutputPath
Write-Host "Diagnostics written to $OutputPath"
if (-not $report.codewhale.companionPairComplete) {
  Write-Warning 'CodeWhale dispatcher/runtime pair is incomplete. Reinstall a matched bundle.'
}
