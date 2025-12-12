/**
 * Build script for cross-platform compilation
 */

import { $ } from 'bun';
import { existsSync, mkdirSync } from 'fs';

const targets = [
  // Use baseline for broader CPU compatibility (no AVX2 requirement)
  { name: 'linux-x64', target: 'bun-linux-x64-baseline', output: 'dockflow-linux-x64' },
  { name: 'linux-arm64', target: 'bun-linux-arm64', output: 'dockflow-linux-arm64' },
  { name: 'windows-x64', target: 'bun-windows-x64-baseline', output: 'dockflow-windows-x64.exe' },
  { name: 'macos-x64', target: 'bun-darwin-x64-baseline', output: 'dockflow-macos-x64' },
  { name: 'macos-arm64', target: 'bun-darwin-arm64', output: 'dockflow-macos-arm64' },
];

async function build() {
  console.log('🚀 Building Dockflow CLI...\n');

  // Create dist directory
  if (!existsSync('dist')) {
    mkdirSync('dist');
  }

  // Get target from command line or build all
  const targetArg = process.argv[2];
  const targetsToBuild = targetArg
    ? targets.filter(t => t.name === targetArg || t.target === targetArg)
    : targets;

  if (targetsToBuild.length === 0) {
    console.error(`Unknown target: ${targetArg}`);
    console.log('Available targets:', targets.map(t => t.name).join(', '));
    process.exit(1);
  }

  for (const { name, target, output } of targetsToBuild) {
    console.log(`📦 Building for ${name}...`);
    
    try {
      await $`bun build src/index.ts --compile --target=${target} --outfile=dist/${output}`;
      console.log(`   ✅ dist/${output}`);
    } catch (error) {
      console.error(`   ❌ Failed to build for ${name}:`, error);
    }
  }

  console.log('\n✨ Build complete!');
  console.log('\nBuilt binaries:');
  
  for (const { output } of targetsToBuild) {
    const path = `dist/${output}`;
    if (existsSync(path)) {
      const file = Bun.file(path);
      const size = await file.size;
      const sizeMB = (size / 1024 / 1024).toFixed(2);
      console.log(`  - ${output} (${sizeMB} MB)`);
    }
  }
}

build();
