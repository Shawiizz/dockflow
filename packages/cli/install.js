#!/usr/bin/env node

/**
 * Dockflow CLI - Binary installer (postinstall)
 *
 * Downloads the correct pre-compiled binary from GitHub Releases
 * based on the current platform and architecture.
 *
 * Zero dependencies - uses only Node.js built-ins.
 */

const { createWriteStream, mkdirSync, chmodSync, existsSync, readFileSync } = require('fs');
const { join, dirname } = require('path');
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

function download(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;

    client.get(url, { headers: { 'User-Agent': 'dockflow-npm-installer' } }, (res) => {
      // Follow redirects (GitHub releases redirect to S3)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location).then(resolve, reject);
      }

      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${res.statusCode} from ${url}`));
        return;
      }

      const binaryPath = getBinaryPath();
      mkdirSync(dirname(binaryPath), { recursive: true });

      const file = createWriteStream(binaryPath);
      res.pipe(file);

      file.on('finish', () => {
        file.close(() => {
          // Make executable on Unix
          if (process.platform !== 'win32') {
            chmodSync(binaryPath, 0o755);
          }
          resolve(binaryPath);
        });
      });

      file.on('error', (err) => {
        reject(err);
      });
    }).on('error', reject);
  });
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

  console.log(`Downloading Dockflow CLI v${version} (${binaryName})...`);

  try {
    const path = await download(url);
    console.log(`Dockflow CLI installed to ${path}`);
  } catch (err) {
    console.error(`\nFailed to download Dockflow CLI binary.`);
    console.error(`URL: ${url}`);
    console.error(`Error: ${err.message}`);
    console.error(`\nYou can install manually:`);
    console.error(`  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash`);
    process.exit(1);
  }
}

main();
