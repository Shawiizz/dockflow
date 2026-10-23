/**
 * The remote commands of the upload and network phases: every path and name from the project's
 * config reaches the server as one quoted word, whatever characters it holds.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { commitUploads, ensureExternalNetworks, rollbackUploads, uploadFiles } from '../commands/deploy-phases';
import type { UploadRollbackPlan } from '../commands/deploy-phases';
import type { DeployContext } from '../commands/deploy-context';
import * as ssh from '../utils/ssh';
import type { SSHKeyConnection } from '../types';
import { hasPosixShell } from './helpers/local-shell';

const CONN: SSHKeyConnection = { host: 'node-1', port: 22, user: 'deploy', privateKey: 'key' };
const OK = { stdout: '', stderr: '', exitCode: 0 };
const AWKWARD = "it's a $HOME *dir";

describe('uploadFiles commands', () => {
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dockflow-upload-cmd-'));
    writeFileSync(join(root, 'app.conf'), 'x=1\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('quotes the destination, the backup and the owner and permissions of a file upload', async () => {
    const commands: string[] = [];
    const exec = spyOn(ssh, 'sshExec').mockImplementation(async (_conn, command) => {
      commands.push(command);
      return command.startsWith('if test -f') ? { ...OK, stdout: 'existed\n' } : OK;
    });
    const dest = `/srv/${AWKWARD}/app.conf`;
    const ctx = {
      stackName: 'shop-production',
      deployVersion: '1.0.0',
      projectRoot: root,
      rendered: new Map(),
      config: { project_name: 'shop', uploads: [{ src: 'app.conf', dest, permissions: '640', owner: 'app:app; touch /tmp/pwned' }] },
      options: {},
      cluster: { manager: { name: 'manager', connection: CONN }, otherManagers: [], workers: [] },
    } as unknown as DeployContext;
    try {
      await uploadFiles(ctx);
    } finally {
      exec.mockRestore();
    }

    const backup = `/var/lib/dockflow/upload-backups/shop-production/1.0.0${dest}`;
    const quoted = (path: string) => `'${path.replace(/'/g, "'\\''")}'`;
    const dir = (path: string) => path.slice(0, path.lastIndexOf('/'));
    expect(commands).toEqual([
      `mkdir -p ${quoted(dir(dest))} ${quoted(dir(backup))}`,
      `if test -f ${quoted(dest)}; then cp ${quoted(dest)} ${quoted(backup)} && echo existed; else echo missing; fi`,
      `cat > ${quoted(dest)}`,
      `chmod '640' ${quoted(dest)}`,
      `chown 'app:app; touch /tmp/pwned' ${quoted(dest)}`,
    ]);
  });
});

describe('rollbackUploads and commitUploads', () => {
  it('restore and drop backups through quoted paths', async () => {
    const commands: string[] = [];
    const exec = spyOn(ssh, 'sshExec').mockImplementation(async (_conn, command) => {
      commands.push(command);
      return OK;
    });
    const plan: UploadRollbackPlan = {
      backupBaseDir: "/backups/it's",
      hosts: [{
        name: 'node-1',
        conn: CONN,
        backedUp: ['/srv/a b'],
        created: ['/srv/new*'],
        backedUpDirs: [{ dest: '/srv/dir $x', backup: "/backups/it's/srv/dir $x.tar.gz" }],
        createdDirs: ['/srv/made'],
      }],
    };
    try {
      await rollbackUploads(plan);
      await commitUploads(plan);
    } finally {
      exec.mockRestore();
    }

    expect(commands[0]).toBe("cp '/backups/it'\\''s/srv/a b' '/srv/a b' && rm -f '/backups/it'\\''s/srv/a b'");
    expect(commands[1]).toBe("rm -f '/srv/new*'");
    expect(commands[2]).toMatch(/^mkdir -p '\/srv\/dir \$x\.dockflow-restore-\d+' && tar xzf '\/backups\/it'\\''s\/srv\/dir \$x\.tar\.gz' -C '\/srv\/dir \$x\.dockflow-restore-\d+'$/);
    expect(commands[3]).toMatch(/^rm -rf '\/srv\/dir \$x' && mv '\/srv\/dir \$x\.dockflow-restore-\d+' '\/srv\/dir \$x'$/);
    expect(commands.slice(4)).toEqual(["rm -rf '/srv/made'", "rm -rf '/backups/it'\\''s'", "rm -rf '/backups/it'\\''s'"]);
  });

  describe.skipIf(!hasPosixShell)('in a real shell', () => {
    let dir = '';
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'dockflow-rollback-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('puts a file back, removes a created one and drops the backups, whatever the path holds', async () => {
      const exec = spyOn(ssh, 'sshExec').mockImplementation(async (_conn, command) => {
        const child = Bun.spawn(['sh', '-c', command], { stdout: 'pipe', stderr: 'pipe' });
        const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
        return { stdout, stderr, exitCode: await child.exited };
      });
      const base = join(dir, AWKWARD);
      const backups = join(base, 'backups');
      const restored = join(base, 'restored.conf');
      const created = join(base, 'created.conf');
      mkdirSync(backups, { recursive: true });
      writeFileSync(restored, 'new\n');
      writeFileSync(created, 'new\n');
      const backup = `${backups}${restored}`;
      mkdirSync(join(backup, '..'), { recursive: true });
      writeFileSync(backup, 'old\n');
      try {
        await rollbackUploads({
          backupBaseDir: backups,
          hosts: [{ name: 'node-1', conn: CONN, backedUp: [restored], created: [created], backedUpDirs: [], createdDirs: [] }],
        });
      } finally {
        exec.mockRestore();
      }

      expect(readFileSync(restored, 'utf8')).toBe('old\n');
      expect(existsSync(created)).toBe(false);
      expect(existsSync(backups)).toBe(false);
    });
  });
});

describe('ensureExternalNetworks', () => {
  it('creates a network whose name holds shell syntax as a single word', async () => {
    const commands: string[] = [];
    const exec = spyOn(ssh, 'sshExec').mockImplementation(async (_conn, command) => {
      commands.push(command);
      return OK;
    });
    const ctx = {
      stackName: 'shop-production',
      rendered: new Map(),
      composeContent: "services:\n  web:\n    image: x\nnetworks:\n  edge:\n    external: true\n    name: \"a'b; touch /tmp/pwned\"\n",
      cluster: { manager: { name: 'manager', connection: CONN }, otherManagers: [], workers: [] },
    } as unknown as DeployContext;
    try {
      await ensureExternalNetworks(ctx);
    } finally {
      exec.mockRestore();
    }

    expect(commands).toEqual([
      "docker network ls --format '{{.Name}}'",
      "docker network create --driver overlay --attachable 'a'\\''b; touch /tmp/pwned'",
    ]);
  });
});
