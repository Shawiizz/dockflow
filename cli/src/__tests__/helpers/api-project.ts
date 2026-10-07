import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI_SRC = join(import.meta.dir, '..', '..');

/**
 * A project directory with two environments, to run API code against the real config loading.
 * The layout and config caches are per process, so each script runs in its own `bun` process.
 */
export class ApiProject {
  readonly dir = mkdtempSync(join(tmpdir(), 'dockflow-api-'));

  constructor() {
    mkdirSync(join(this.dir, '.dockflow'), { recursive: true });
    writeFileSync(join(this.dir, '.dockflow', 'config.yml'), 'project_name: shop\n');
    writeFileSync(
      join(this.dir, '.dockflow', 'servers.yml'),
      [
        'servers:',
        '  m1:',
        '    role: manager',
        '    host: 10.0.0.1',
        '    tags: [production]',
        '  m2:',
        '    role: manager',
        '    host: 10.0.0.2',
        '    tags: [production]',
        '  w1:',
        '    role: worker',
        '    host: 10.0.0.3',
        '    tags: [production]',
        '  stg:',
        '    role: manager',
        '    host: 10.0.1.1',
        '    tags: [staging]',
        '',
      ].join('\n'),
    );
  }

  /** Runs `body` (module code, `await` allowed) and returns what it printed as JSON. */
  async run<T>(body: string): Promise<T> {
    const script = join(this.dir, 'script.ts');
    writeFileSync(script, `const api = (path: string) => import(${JSON.stringify(CLI_SRC)} + '/' + path);\n${body}\n`);
    const proc = Bun.spawn([process.execPath, script], {
      cwd: this.dir,
      env: { ...process.env, PRODUCTION_SSH_PRIVATE_KEY: 'key', STAGING_SSH_PRIVATE_KEY: 'key' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`script failed (${code}): ${err}`);
    return JSON.parse(out.trim().split('\n').pop() as string) as T;
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
