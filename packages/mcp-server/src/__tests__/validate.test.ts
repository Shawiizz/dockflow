import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  detectFileType,
  FILE_NAMES,
  formatValidationResult,
  validateConfig,
  validateFile,
  validateServersOnly,
} from '../validate.js';

const SERVER = 'servers:\n  main:\n    tags: [production]\n';

describe('validateConfig', () => {
  it('accepts a project name alone', () => {
    assert.deepEqual(validateConfig('project_name: shop\n'), { valid: true, errors: [] });
  });

  it('reports YAML that does not parse and a document that is not a mapping', () => {
    assert.match(validateConfig('project_name: [shop').errors[0], /^YAML parse error: /);
    assert.deepEqual(validateConfig('- shop\n').errors, ['Root must be a YAML object']);
    assert.deepEqual(validateConfig('').errors, ['Root must be a YAML object']);
  });

  it('prints one "<path>: <message>" line per issue, ordered by path', () => {
    const result = validateConfig('registry:\n  type: custom\ncontainer_engine: nerdctl\nproject_name: Shop\n');
    assert.deepEqual(result.errors, [
      'container_engine: must be "docker" or "podman"',
      'project_name: Project name must contain only lowercase letters, numbers, and hyphens. Cannot start or end with a hyphen.',
      'registry: Custom registry type requires a URL',
    ]);
  });

  it('writes list positions as name[i].key, the way the CLI does', () => {
    const result = validateConfig(
      'project_name: shop\nproxy:\n  routes:\n    - service: api\n      domains: {production: "https://api.example.com"}\n',
    );
    assert.deepEqual(result.errors, ['proxy.routes[0].domains.production: must be a domain name, e.g. panel.example.com']);
  });

  it('does not repeat a message that two rules produce for the same path', () => {
    const errors = validateConfig('project_name: ""\n').errors;
    assert.equal(errors.length, new Set(errors).size);
    assert.ok(errors.includes('project_name: Project name is required'));
  });

  it('does not require an email for an enabled proxy', () => {
    assert.equal(validateConfig('project_name: shop\nproxy:\n  enabled: true\n').valid, true);
  });

  it('checks the servers block when there is one', () => {
    const result = validateConfig('project_name: shop\nservers:\n  Main:\n    tags: [production]\n');
    assert.deepEqual(result.errors, ['servers.Main: Server name must be lowercase alphanumeric with hyphens or underscores']);
  });

  it('does not coerce a tag that is not a string', () => {
    const result = validateConfig('project_name: shop\nservers:\n  main:\n    tags: [production, 1, true]\n');
    assert.deepEqual(result.errors, ['servers.main.tags[1]: must be a string', 'servers.main.tags[2]: must be a string']);
  });
});

describe('validateServersOnly', () => {
  it('accepts workers beside a manager of the same environment', () => {
    const content = `${SERVER}  worker-1:\n    role: worker\n    tags: [production]\n`;
    assert.equal(validateServersOnly(content).valid, true);
  });

  it('requires the servers key', () => {
    assert.deepEqual(validateServersOnly('defaults:\n  user: deploy\n').errors, ['servers: required']);
  });

  it('requires at least one server', () => {
    assert.deepEqual(validateServersOnly('servers: {}\n').errors, ['servers: At least one server must be defined']);
  });

  it('limits the server name to 63 characters', () => {
    const name = 'a'.repeat(64);
    assert.deepEqual(validateServersOnly(`servers:\n  ${name}:\n    tags: [production]\n`).errors, [
      `servers.${name}: Server name must be 63 characters or less`,
    ]);
  });

  it('limits a tag to 50 characters', () => {
    assert.deepEqual(validateServersOnly(`servers:\n  main:\n    tags: [${'a'.repeat(51)}]\n`).errors, [
      'servers.main.tags[0]: Tag must be 50 characters or less',
    ]);
  });

  it('wants an integer port between 1 and 65535, on a server and in the defaults', () => {
    assert.deepEqual(validateServersOnly('servers:\n  main:\n    port: 22.5\n    tags: [production]\n').errors, [
      'servers.main.port: must be an integer between 1 and 65535',
    ]);
    assert.deepEqual(validateServersOnly(`${SERVER}defaults:\n  port: 70000\n`).errors, [
      'defaults.port: must be an integer between 1 and 65535',
    ]);
  });

  it('limits the user to 32 characters, on a server and in the defaults', () => {
    const user = 'u'.repeat(33);
    assert.equal(validateServersOnly(`servers:\n  main:\n    user: ${user}\n    tags: [production]\n`).valid, false);
    assert.deepEqual(validateServersOnly(`${SERVER}defaults:\n  user: ${user}\n`).errors, [
      'defaults.user: must be a user name of 1 to 32 characters',
    ]);
  });

  it('wants a host that is a string', () => {
    assert.deepEqual(validateServersOnly('servers:\n  main:\n    host: 12345\n    tags: [production]\n').errors, [
      'servers.main.host: must be a string',
    ]);
  });

  it('names the rule an environment variable breaks', () => {
    const content = 'servers:\n  main:\n    tags: [production]\n    env:\n      1ST: one\n      PORT: 8080\n';
    assert.deepEqual(validateServersOnly(content).errors, [
      'servers.main.env.1ST: Environment variable names must start with a letter and contain only letters, numbers, and underscores',
      'servers.main.env.PORT: must be a string',
    ]);
  });

  it('wants a manager for every environment, with the CLI message', () => {
    const content =
      'servers:\n  main:\n    tags: [production]\n  worker-1:\n    role: worker\n    tags: [production, staging]\n';
    assert.deepEqual(validateServersOnly(content).errors, ['root: Each environment tag must have at least one manager server']);
  });
});

describe('detectFileType and validateFile', () => {
  it('tells a dockflow.yml, a servers.yml and a config.yml apart', () => {
    assert.equal(detectFileType(`project_name: shop\n${SERVER}`), 'root');
    assert.equal(detectFileType(SERVER), 'servers');
    assert.equal(detectFileType('project_name: shop\n'), 'config');
    assert.equal(detectFileType('registry: ['), 'config');
    assert.equal(detectFileType('servers: {}\n'), 'servers');
  });

  it('validates each kind of file by its own rules', () => {
    assert.equal(validateFile(SERVER, 'servers').valid, true);
    assert.equal(validateFile(SERVER, 'config').errors[0], 'project_name: required');
    assert.equal(validateFile('project_name: shop\n', 'root').errors[0], 'servers: required');
    assert.equal(validateFile(`project_name: shop\n${SERVER}`, 'root').valid, true);
  });

  it('names each file the way the project does', () => {
    assert.deepEqual(FILE_NAMES, { root: 'dockflow.yml', config: 'config.yml', servers: 'servers.yml' });
  });
});

describe('formatValidationResult', () => {
  it('prints a valid file on one line', () => {
    assert.equal(formatValidationResult({ valid: true, errors: [] }, 'config.yml'), '✓ config.yml is valid.');
  });

  it('counts the issues and lists them under the file name', () => {
    const text = formatValidationResult({ valid: false, errors: ['a: x', 'b: y'] }, 'servers.yml');
    assert.equal(text, '✗ servers.yml has 2 error(s):\n\n  → a: x\n  → b: y');
  });
});
