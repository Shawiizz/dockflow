import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { formatProjectConfig, readProjectConfig } from '../project.js';

let root: string;

function write(path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const paths = (cwd: string): string[] => readProjectConfig(cwd).files.map((f) => f.path);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dockflow-mcp-project-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('read_project_config', () => {
  it('reports no project outside a Dockflow directory', () => {
    const result = readProjectConfig(root);
    assert.equal(result.layout, 'none');
    assert.deepEqual(result.files, []);
    assert.ok(formatProjectConfig(result).includes('No Dockflow configuration found'));
  });

  it('standard layout: config, servers, compose and accessories files', () => {
    write('.dockflow/config.yml', 'project_name: shop\n');
    write('.dockflow/servers.yml', 'servers:\n  main:\n    host: 203.0.113.10\n    tags: [production]\n');
    write('.dockflow/docker/docker-compose.yml', 'services:\n  web:\n    image: web\n');
    write('.dockflow/docker/accessories.yml', 'services:\n  db:\n    image: postgres:16\n');

    assert.deepEqual(paths(root), [
      '.dockflow/config.yml',
      '.dockflow/servers.yml',
      '.dockflow/docker/docker-compose.yml',
      '.dockflow/docker/accessories.yml',
    ]);
  });

  it('standard layout: a .yaml compose file, and no accessories.yaml (the CLI reads only accessories.yml)', () => {
    write('.dockflow/config.yml', 'project_name: shop\n');
    write('.dockflow/docker/docker-compose.yaml', 'services:\n  web:\n    image: web\n');
    write('.dockflow/docker/accessories.yaml', 'services:\n  db:\n    image: postgres:16\n');

    assert.deepEqual(paths(root), ['.dockflow/config.yml', '.dockflow/docker/docker-compose.yaml']);
  });

  it('standard layout: a compose file is not required', () => {
    write('.dockflow/config.yml', 'project_name: shop\n');
    assert.deepEqual(paths(root), ['.dockflow/config.yml']);
  });

  it('flat layout: dockflow.yml, compose and accessories at the root', () => {
    write('dockflow.yml', 'project_name: shop\nservers:\n  main:\n    tags: [production]\n');
    write('docker-compose.yml', 'services:\n  web:\n    image: web\n');
    write('accessories.yml', 'services:\n  redis:\n    image: redis:7.4\n');

    assert.deepEqual(paths(root), ['dockflow.yml', 'docker-compose.yml', 'accessories.yml']);
  });

  it('flat layout: the .yaml variants at the root', () => {
    write('dockflow.yml', 'project_name: shop\n');
    write('docker-compose.yaml', 'services:\n  web:\n    image: web\n');
    write('accessories.yaml', 'services:\n  redis:\n    image: redis:7.4\n');

    assert.deepEqual(paths(root), ['dockflow.yml', 'docker-compose.yaml', 'accessories.yaml']);
  });

  it('flat layout: falls back to .dockflow/docker when the root has no compose or accessories file', () => {
    write('dockflow.yml', 'project_name: shop\n');
    write('.dockflow/docker/docker-compose.yml', 'services:\n  web:\n    image: web\n');
    write('.dockflow/docker/accessories.yml', 'services:\n  redis:\n    image: redis:7.4\n');

    assert.deepEqual(paths(root), ['dockflow.yml', '.dockflow/docker/docker-compose.yml', '.dockflow/docker/accessories.yml']);
  });

  it('flat layout: the root compose file wins over the one in .dockflow/docker', () => {
    write('dockflow.yml', 'project_name: shop\n');
    write('docker-compose.yml', 'services:\n  root:\n    image: web\n');
    write('.dockflow/docker/docker-compose.yml', 'services:\n  nested:\n    image: web\n');

    const result = readProjectConfig(root);
    assert.deepEqual(result.files.map((f) => f.path), ['dockflow.yml', 'docker-compose.yml']);
    assert.ok(result.files[1].content.includes('root:'));
  });

  it('skips a directory that has the name of a file instead of failing', () => {
    write('.dockflow/config.yml', 'project_name: shop\n');
    mkdirSync(join(root, '.dockflow', 'docker', 'docker-compose.yml'), { recursive: true });
    write('.dockflow/docker/docker-compose.yaml', 'services:\n  web:\n    image: web\n');
    mkdirSync(join(root, '.dockflow', 'docker', 'accessories.yml'), { recursive: true });

    assert.deepEqual(paths(root), ['.dockflow/config.yml', '.dockflow/docker/docker-compose.yaml']);
  });

  it('never returns .env.dockflow', () => {
    write('dockflow.yml', 'project_name: shop\n');
    write('.env.dockflow', 'PRODUCTION_MAIN_CONNECTION=secret\n');
    write('.dockflow/.env.dockflow', 'PRODUCTION_MAIN_CONNECTION=secret\n');

    const result = readProjectConfig(root);
    assert.deepEqual(result.files.map((f) => f.path), ['dockflow.yml']);
    assert.ok(!formatProjectConfig(result).includes('secret'));
  });

  it('finds the project from a subdirectory', () => {
    write('.dockflow/config.yml', 'project_name: shop\n');
    mkdirSync(join(root, 'src', 'app'), { recursive: true });
    const result = readProjectConfig(join(root, 'src', 'app'));
    assert.equal(result.layout, 'standard');
    assert.deepEqual(result.files.map((f) => f.path), ['.dockflow/config.yml']);
  });

  it('shows each file under its relative path with its language', () => {
    write('.dockflow/config.yml', 'project_name: shop\n');
    const text = formatProjectConfig(readProjectConfig(root));
    assert.ok(text.includes('Layout: **standard**'));
    assert.ok(text.includes('### `.dockflow/config.yml`\n```yaml\nproject_name: shop\n\n```'));
  });
});
