#!/usr/bin/env node
/**
 * Builds the real cli/ui Angular app and drops it into docs/public/ui-demo,
 * so the landing page can embed the actual WebUI (mocked backend) instead of
 * a static screenshot. Runs as part of the docs build — see package.json.
 *
 * Plain Node (no bash/sh) so this works the same on Windows, macOS, Linux and
 * in Docker without needing a POSIX shell on PATH.
 */
import { existsSync, cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const UI_DIR = join(DOCS_DIR, '..', 'cli', 'ui')
const OUT_DIR = join(DOCS_DIR, 'public', 'ui-demo')

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`)
  }
}

function main() {
  const ifMissing = process.argv.includes('--if-missing')
  if (ifMissing && existsSync(OUT_DIR)) {
    console.log('public/ui-demo already exists, skipping (run `pnpm run build:ui-demo` to force a rebuild).')
    return
  }

  if (!existsSync(UI_DIR)) {
    // The Docker image builds this stage with a docs-only context, so cli/ui
    // isn't available here — the pre-built bundle was already placed in
    // public/ui-demo by an earlier build stage. Nothing to do.
    console.log(`cli/ui not found at ${UI_DIR} — assuming public/ui-demo was already built (Docker multi-stage build).`)
    return
  }

  console.log('Installing cli/ui dependencies...')
  // pnpm itself is a platform-specific shim (pnpm.cmd on Windows) — resolve it
  // through a shell, but pass the whole command as one string to avoid Node's
  // "unescaped args with shell:true" warning (there's no dynamic input here).
  run('pnpm install --frozen-lockfile', [], { cwd: UI_DIR, shell: true })

  console.log('Building cli/ui for the demo (base-href=/ui-demo/)...')
  // Invoke the Angular CLI's JS entry point directly with the current Node
  // binary — no shell involved, so there's nothing to mangle the /ui-demo/
  // argument (a known issue when a shell like Git Bash sits in between).
  const ngEntry = join(UI_DIR, 'node_modules', '@angular', 'cli', 'bin', 'ng.js')
  run(process.execPath, [
    ngEntry,
    'build',
    '--configuration', 'production',
    '--base-href', '/ui-demo/',
    '--output-path', 'dist/ui-demo',
  ], { cwd: UI_DIR })

  console.log(`Copying build output to ${OUT_DIR}...`)
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })
  cpSync(join(UI_DIR, 'dist', 'ui-demo', 'browser'), OUT_DIR, { recursive: true })

  console.log('Injecting mock WebSocket shim...')
  cpSync(join(DOCS_DIR, 'scripts', 'ui-demo-mock.js'), join(OUT_DIR, 'mock.js'))
  const indexPath = join(OUT_DIR, 'index.html')
  const html = readFileSync(indexPath, 'utf-8')
  const scriptTag = '  <script src="/ui-demo/mock.js"></script>\n</head>'
  writeFileSync(indexPath, html.replace('</head>', scriptTag))

  console.log(`UI demo ready at ${OUT_DIR}`)
}

main()
