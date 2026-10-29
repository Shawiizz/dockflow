# Installs the dockflow CLI on Windows from a GitHub release (ADR-0020). The binary is checked
# against the release's SHA256SUMS, and SHA256SUMS against its Sigstore signature when cosign is
# installed. With -RequireSignature, a missing cosign fails the installation instead.
#
#   irm https://raw.githubusercontent.com/Shawiizz/dockflow/main/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Shawiizz/dockflow/main/install.ps1))) -Version vX.Y.Z -Dir C:\tools
#
# DOCKFLOW_VERSION, DOCKFLOW_INSTALL_DIR and DOCKFLOW_REQUIRE_SIGNATURE=1 do the same as the
# options. DOCKFLOW_RELEASES_URL replaces https://github.com/Shawiizz/dockflow/releases/download
# (a mirror).
param(
    [string]$Version = $env:DOCKFLOW_VERSION,
    [string]$Dir = $env:DOCKFLOW_INSTALL_DIR,
    [switch]$RequireSignature = ($env:DOCKFLOW_REQUIRE_SIGNATURE -eq '1')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$repo = 'Shawiizz/dockflow'
$releases = if ($env:DOCKFLOW_RELEASES_URL) { $env:DOCKFLOW_RELEASES_URL.TrimEnd('/') } else { "https://github.com/$repo/releases/download" }

function Fail([string]$msg) { throw "install.ps1: $msg" }

# Windows on ARM runs the amd64 binary
$name = 'dockflow-windows-amd64.exe'

if (-not $Version) {
    # the newest release of this CLI, its tags v<semver>: the API does not list them by date
    try {
        $list = Invoke-RestMethod -UseBasicParsing "https://api.github.com/repos/$repo/releases?per_page=100"
    } catch {
        Fail "cannot list the releases; pass -Version"
    }
    $Version = ($list | Where-Object { $_.tag_name -match '^v[0-9]' -and $_.published_at } |
        Sort-Object published_at -Descending | Select-Object -First 1).tag_name
    if (-not $Version) { Fail 'no release found; pass -Version' }
}
if ($Version -match '^[0-9]') { $Version = "v$Version" }

$base = "$releases/$Version"
Write-Host "installing dockflow $Version (windows/amd64)"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("dockflow-" + [Guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
try {
    foreach ($f in 'SHA256SUMS', $name) {
        try {
            Invoke-WebRequest -UseBasicParsing "$base/$f" -OutFile (Join-Path $tmp $f)
        } catch {
            Fail "cannot download $base/$f"
        }
    }

    if (Get-Command cosign -ErrorAction SilentlyContinue) {
        try {
            Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS.sigstore.json" -OutFile (Join-Path $tmp 'SHA256SUMS.sigstore.json')
        } catch {
            Fail 'cannot download the signature of SHA256SUMS'
        }
        & cosign verify-blob --bundle (Join-Path $tmp 'SHA256SUMS.sigstore.json') `
            --certificate-identity-regexp "^https://github.com/$repo/.github/workflows/release.yml@refs/tags/v" `
            --certificate-oidc-issuer https://token.actions.githubusercontent.com `
            (Join-Path $tmp 'SHA256SUMS') *> $null
        if ($LASTEXITCODE) { Fail 'the signature of SHA256SUMS does not verify' }
        Write-Host 'signature verified'
    } elseif ($RequireSignature) {
        Fail 'the signature is required and cosign is not installed: install cosign (https://docs.sigstore.dev/cosign/system_config/installation/)'
    } else {
        Write-Host 'cosign is not installed: checking the checksum only'
    }

    $want = $null
    foreach ($line in Get-Content (Join-Path $tmp 'SHA256SUMS')) {
        $f = -split $line
        if ($f.Count -eq 2 -and $f[1].TrimStart('*') -eq $name) { $want = $f[0] }
    }
    if (-not $want) { Fail "the release lists no $name" }
    $got = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $name)).Hash.ToLower()
    if ($got -ne $want.ToLower()) { Fail "$name does not match its checksum" }

    if (-not $Dir) { $Dir = Join-Path $env:LOCALAPPDATA 'Programs\dockflow' }
    New-Item -ItemType Directory -Force $Dir | Out-Null
    Move-Item -Force (Join-Path $tmp $name) (Join-Path $Dir 'dockflow.exe')
    Write-Host "installed $(Join-Path $Dir 'dockflow.exe')"
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$onPath = ($env:Path -split ';') + ($userPath -split ';') | Where-Object { $_ -and $_.TrimEnd('\') -eq $Dir.TrimEnd('\') }
if (-not $onPath) {
    if ($env:GITHUB_PATH) {
        Add-Content -Encoding utf8 $env:GITHUB_PATH $Dir
    } else {
        [Environment]::SetEnvironmentVariable('Path', ((@($userPath, $Dir) | Where-Object { $_ }) -join ';'), 'User')
        $env:Path = "$env:Path;$Dir"
        Write-Host "added $Dir to your PATH; open a new terminal to use it"
    }
}
