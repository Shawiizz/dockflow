# Dockflow CLI Installer for Windows
# Usage: irm https://raw.githubusercontent.com/Shawiizz/dockflow/main/install.ps1 | iex

$ErrorActionPreference = "Stop"

# Version to install (override with DOCKFLOW_VERSION env var)
$Version = if ($env:DOCKFLOW_VERSION) { $env:DOCKFLOW_VERSION } else { "latest" }

# Detect architecture
$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }

# Resolve latest version from GitHub if needed
if ($Version -eq "latest") {
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/Shawiizz/dockflow/releases/latest" -UseBasicParsing
        $Version = $release.tag_name
    } catch {
        Write-Error "Failed to fetch latest version from GitHub: $_"
        exit 1
    }
}

# Build download URL
$binaryName = "dockflow-windows-$arch.exe"
$downloadUrl = "https://github.com/Shawiizz/dockflow/releases/download/$Version/$binaryName"
# Every release publishes the SHA-256 of its binaries
$sumsUrl = "https://github.com/Shawiizz/dockflow/releases/download/$Version/SHA256SUMS"

# Determine install location
$installDir = "$env:LOCALAPPDATA\dockflow"
$installPath = "$installDir\dockflow.exe"

# Create install directory
if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}

Write-Host "Downloading Dockflow CLI..."
Write-Host "  Version: $Version"
Write-Host "  Platform: windows-$arch"
Write-Host "  URL: $downloadUrl"
Write-Host ""

# Download into a temporary directory: the binary reaches $installPath only once verified
$tmpDir = Join-Path ([IO.Path]::GetTempPath()) ("dockflow-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmpDir | Out-Null
try {
    $tmpBinary = Join-Path $tmpDir $binaryName
    try {
        Invoke-WebRequest -Uri $downloadUrl -OutFile $tmpBinary -UseBasicParsing
    } catch {
        Write-Error "Failed to download: $_"
        exit 1
    }

    $tmpSums = Join-Path $tmpDir "SHA256SUMS"
    try {
        Invoke-WebRequest -Uri $sumsUrl -OutFile $tmpSums -UseBasicParsing
    } catch {
        Write-Error "Release $Version publishes no SHA256SUMS, so the download cannot be verified. Releases made before checksums can be downloaded by hand: https://github.com/Shawiizz/dockflow/releases"
        exit 1
    }

    $expected = $null
    foreach ($line in Get-Content $tmpSums) {
        if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$' -and $Matches[2].Trim() -eq $binaryName) {
            $expected = $Matches[1].ToLower()
        }
    }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $tmpBinary).Hash.ToLower()
    if (-not $expected -or $expected -ne $actual) {
        $listed = if ($expected) { $expected } else { "nothing listed for $binaryName" }
        Write-Error "The SHA-256 of $binaryName does not match the release. Expected: $listed. Got: $actual"
        exit 1
    }

    Move-Item -Force -Path $tmpBinary -Destination $installPath
} finally {
    Remove-Item -Recurse -Force -Path $tmpDir -ErrorAction SilentlyContinue
}

Write-Host "✓ Dockflow CLI installed to $installPath (SHA-256 verified)" -ForegroundColor Green
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
