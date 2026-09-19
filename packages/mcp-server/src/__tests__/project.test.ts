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
  it('standard layout: config, servers, compose and accessories files', () => {
    write('.dockflow/config.yml', 'project_name: shop\norchestrator: k3s\n');
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

  it('standard layout: accessories.yaml when present, nothing when absent', () => {
    write('.dockflow/config.yml', 'project_name: shop\n');
    assert.ok(!paths(root).some((p) => p.includes('accessories')));

    write('.dockflow/docker/accessories.yaml', 'services:\n  db:\n    image: postgres:16\n');
    assert.ok(paths(root).includes('.dockflow/docker/accessories.yaml'));
  });

  it('flat layout: dockflow.yml, compose and accessories at the root', () => {
    write('dockflow.yml', 'project_name: shop\nservers:\n  main:\n    tags: [production]\n');
    write('docker-compose.yml', 'services:\n  web:\n    image: web\n');
    write('accessories.yml', 'services:\n  redis:\n    image: redis:7.4\n');

    assert.deepEqual(paths(root), ['dockflow.yml', 'docker-compose.yml', 'accessories.yml']);
  });

  it('never returns .env.dockflow or Helm values files', () => {
    write('dockflow.yml', 'project_name: shop\norchestrator: k3s\nhelm:\n  releases:\n    - name: web\n      values_files: [.dockflow/helm/web.yml]\n');
    write('.env.dockflow', 'PRODUCTION_MAIN_CONNECTION=secret\n');
    write('.dockflow/.env.dockflow', 'PRODUCTION_MAIN_CONNECTION=secret\n');
    write('.dockflow/helm/web.yml', 'password: secret\n');
    write('helm/values.yml', 'password: secret\n');

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

  it('describes a k3s project, its Helm releases and a Helm-only project', () => {
    write('dockflow.yml', [
      'project_name: shop',
      'orchestrator: k3s',
      'helm:',
      '  releases:',
      '    - name: podinfo',
      '      chart: podinfo',
      '    - name: cache',
      '      role: accessory',
      '      auth:',
      '        password: {{ current.env.registry_password | dump }}',
    ].join('\n'));

    const result = readProjectConfig(root);
    assert.equal(result.orchestrator, 'k3s');
    assert.deepEqual(result.helmReleases, [{ name: 'podinfo', role: 'app' }, { name: 'cache', role: 'accessory' }]);
    assert.equal(result.hasCompose, false);
    const text = formatProjectConfig(result);
    assert.ok(text.includes('Orchestrator: **k3s**'));
    assert.ok(text.includes('podinfo (app), cache (accessory)'));
    assert.ok(text.includes('Helm-only project'));
  });

  it('describes a swarm project', () => {
    write('.dockflow/config.yml', 'project_name: shop\n');
    write('.dockflow/docker/docker-compose.yml', 'services:\n  web:\n    image: web\n');
    const result = readProjectConfig(root);
    assert.equal(result.orchestrator, 'swarm');
    assert.equal(result.hasCompose, true);
    assert.ok(formatProjectConfig(result).includes('Orchestrator: **swarm**'));
  });
});
