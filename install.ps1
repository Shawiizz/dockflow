# Dockflow CLI Installer for Windows
# Usage: irm https://raw.githubusercontent.com/Shawiizz/dockflow/main/install.ps1 | iex

$ErrorActionPreference = "Stop"

# Version to install
$Version = "2.0.2"

# Detect architecture
$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }

# Build download URL
$binaryName = "dockflow-windows-$arch.exe"
$downloadUrl = "https://github.com/Shawiizz/dockflow/releases/download/$Version/$binaryName"

# Determine install location
$installDir = "$env:LOCALAPPDATA\dockflow"
$installPath = "$installDir\dockflow.exe"

# Create install directory
if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}

Write-Host "Downloading Dockflow CLI..."
Write-Host "  Platform: windows-$arch"
Write-Host "  URL: $downloadUrl"
Write-Host ""

# Download
try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $installPath -UseBasicParsing
} catch {
    Write-Error "Failed to download: $_"
    exit 1
}

Write-Host "✓ Dockflow CLI installed to $installPath" -ForegroundColor Green
Write-Host ""

# Add to PATH if not already there
$currentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($currentPath -notlike "*$installDir*") {
    Write-Host "Adding to PATH..."
    [Environment]::SetEnvironmentVariable(
        "PATH",
        "$currentPath;$installDir",
        "User"
    )
    $env:PATH = "$env:PATH;$installDir"
    Write-Host "✓ Added $installDir to PATH" -ForegroundColor Green
}

Write-Host ""
Write-Host "Run 'dockflow --help' to get started"
Write-Host ""
Write-Host "Note: You may need to restart your terminal for PATH changes to take effect."
