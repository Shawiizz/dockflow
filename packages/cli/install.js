#!/usr/bin/env node

/**
 * Dockflow CLI - Binary installer (postinstall)
 *
 * Downloads the correct pre-compiled binary from GitHub Releases
 * based on the current platform and architecture, and installs it only
 * once its SHA-256 matches the one in the SHA256SUMS published with this
 * package version.
 *
 * Zero dependencies - uses only Node.js built-ins.
 */

const { createWriteStream, mkdirSync, chmodSync, existsSync, readFileSync, renameSync, rmSync } = require('fs');
const { join, dirname } = require('path');
const { createHash } = require('crypto');
const https = require('https');
const http = require('http');

const REPO = 'Shawiizz/dockflow';

const PLATFORM_MAP = {
  linux: 'linux',
  darwin: 'macos',
  win32: 'windows',
};

const ARCH_MAP = {
  x64: 'x64',
  arm64: 'arm64',
};

function getVersion() {
  const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));
  return pkg.version;
}

function getBinaryName() {
  const platform = PLATFORM_MAP[process.platform];
  const arch = ARCH_MAP[process.arch];

  if (!platform) {
    throw new Error(`Unsupported platform: ${process.platform}. Supported: linux, darwin, win32`);
  }
  if (!arch) {
    throw new Error(`Unsupported architecture: ${process.arch}. Supported: x64, arm64`);
  }

  const name = `dockflow-${platform}-${arch}`;
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function getBinaryPath() {
  const binDir = join(__dirname, 'bin');
  const ext = process.platform === 'win32' ? '.exe' : '';
  return join(binDir, `dockflow${ext}`);
}

/**
 * The SHA-256 the release published for `binaryName`, from the SHA256SUMS file
 * packed with this package (lines of `sha256sum`: `<hash>  <name>` or `<hash> *<name>`).
 */
function getExpectedChecksum(binaryName) {
  const sumsPath = join(__dirname, 'SHA256SUMS');
  if (!existsSync(sumsPath)) {
    throw new Error('This package carries no SHA256SUMS, so the binary cannot be verified');
  }
  for (const line of readFileSync(sumsPath, 'utf8').split('\n')) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (match && match[2] === binaryName) return match[1].toLowerCase();
  }
  throw new Error(`SHA256SUMS lists no checksum for ${binaryName}`);
}

/** Download `url` into `dest`, resolving with the SHA-256 of what was written. */
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;

    client.get(url, { headers: { 'User-Agent': 'dockflow-npm-installer' } }, (res) => {
      // Follow redirects (GitHub releases redirect to S3)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, dest).then(resolve, reject);
      }

      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Download failed: HTTP ${res.statusCode} from ${url}`));
        return;
      }

      mkdirSync(dirname(dest), { recursive: true });

      const hash = createHash('sha256');
      const file = createWriteStream(dest);
      res.on('data', (chunk) => hash.update(chunk));
      res.on('error', reject);
      res.pipe(file);

      file.on('finish', () => {
        file.close(() => resolve(hash.digest('hex')));
      });

      file.on('error', (err) => {
        reject(err);
      });
    }).on('error', reject);
  });
}

/** Antivirus software may hold a new .exe for a moment on Windows: the rename is retried briefly. */
async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const busy = ['EPERM', 'EBUSY', 'EACCES'].includes(err.code);
      if (process.platform !== 'win32' || !busy || attempt === 10) throw err;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

async function main() {
  const binaryPath = getBinaryPath();

  // Skip if binary already exists (e.g. re-running postinstall)
  if (existsSync(binaryPath)) {
    return;
  }

  const version = getVersion();
  const binaryName = getBinaryName();
  const url = `https://github.com/${REPO}/releases/download/${version}/${binaryName}`;
  // The binary lands under its final name only once verified: run.js runs whatever is there.
  const partialPath = `${binaryPath}.download`;

  console.log(`Downloading Dockflow CLI v${version} (${binaryName})...`);

  try {
    const expected = getExpectedChecksum(binaryName);
    const actual = await download(url, partialPath);
    if (actual !== expected) {
      throw new Error(`SHA-256 mismatch: the release published ${expected}, the download is ${actual}`);
    }
    // Make executable on Unix
    if (process.platform !== 'win32') {
      chmodSync(partialPath, 0o755);
    }
    await renameWithRetry(partialPath, binaryPath);
    console.log(`Dockflow CLI installed to ${binaryPath} (SHA-256 verified)`);
  } catch (err) {
    rmSync(partialPath, { force: true });
    console.error(`\nFailed to install the Dockflow CLI binary.`);
    console.error(`URL: ${url}`);
    console.error(`Error: ${err.message}`);
    console.error(`\nYou can install manually:`);
    console.error(`  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash`);
    process.exit(1);
  }
}

main();
