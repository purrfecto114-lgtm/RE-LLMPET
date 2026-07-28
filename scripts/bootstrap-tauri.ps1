param(
  [switch]$InstallSystemDependencies
)
$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')

if ($InstallSystemDependencies) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'winget is required for automated Windows prerequisite installation.'
  }
  winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --silent --accept-package-agreements --accept-source-agreements --override '--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
  winget install --id Microsoft.EdgeWebView2Runtime --exact --silent --accept-package-agreements --accept-source-agreements
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'Install Rust with rustup, then rerun this script.'
  }
  winget install --id Rustlang.Rustup --exact --silent --accept-package-agreements --accept-source-agreements
  $env:Path = "$HOME\.cargo\bin;$env:Path"
}

try { cargo tauri --version | Out-Null }
catch { cargo install tauri-cli --version '^2.0.0' --locked }

Set-Location $Root
npm test
cargo check --manifest-path src-tauri/Cargo.toml --all-targets
Write-Host 'Toolchain ready. Start development with: npm start'
