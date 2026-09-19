import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { EXAMPLES, formatExample, listExamples, SCENARIO_DESCRIPTION, type Example } from '../examples.js';
import { stubTemplates, validateConfig, validateServersOnly, type Orchestrator } from '../validate.js';

const isYaml = (path: string): boolean => /\.ya?ml$/.test(path);
const basename = (path: string): string => path.split('/').pop() ?? path;

/** The orchestrator an example's config.yml or dockflow.yml declares, swarm by default */
function orchestratorOf(example: Example): Orchestrator {
  const config = example.files.find((f) => ['config.yml', 'dockflow.yml'].includes(basename(f.path)));
  if (!config) return 'swarm';
  const doc = parseYaml(stubTemplates(config.content)) as { orchestrator?: Orchestrator };
  return doc.orchestrator ?? 'swarm';
}

function example(id: string): Example {
  const found = EXAMPLES.find((e) => e.id === id);
  assert.ok(found, `example ${id} is missing`);
  return found;
}

describe('get_examples', () => {
  it('lists in its description exactly the ids of EXAMPLES, in order', () => {
    const match = /^Scenario id: (.+)\. Omit to list all\.$/.exec(SCENARIO_DESCRIPTION);
    assert.ok(match, SCENARIO_DESCRIPTION);
    assert.deepEqual(match[1].split(', '), EXAMPLES.map((e) => e.id));
  });

  it('offers the k3s examples of the design and ids that are unique', () => {
    const ids = EXAMPLES.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ['k3s', 'k3s-cluster', 'k3s-helm', 'k3s-helm-only']) assert.ok(ids.includes(id), id);
  });

  for (const ex of EXAMPLES) {
    describe(ex.id, () => {
      for (const file of ex.files.filter((f) => isYaml(f.path))) {
        it(`${file.path} parses as YAML`, () => {
          assert.doesNotThrow(() => parseYaml(stubTemplates(file.content)));
        });
      }

      for (const file of ex.files) {
        const name = basename(file.path);
        if (name === 'dockflow.yml' || name === 'config.yml') {
          it(`${file.path} passes validate_config`, () => {
            assert.deepEqual(validateConfig(file.content).errors, []);
          });
        }
        if (name === 'servers.yml') {
          it(`${file.path} passes validate_config for its orchestrator`, () => {
            assert.deepEqual(validateServersOnly(file.content, { orchestrator: orchestratorOf(ex) }).errors, []);
          });
        }
      }
    });
  }
});

describe('k3s examples', () => {
  it('show the complete setup command with a bootstrap identity', () => {
    for (const id of ['k3s', 'k3s-cluster', 'k3s-helm', 'k3s-helm-only']) {
      const text = formatExample(example(id));
      assert.ok(text.includes('dockflow setup k3s production --ssh-user root -k ~/.ssh/bootstrap_ed25519'), id);
    }
  });

  it('k3s: private_host, a published port, a sized accessory volume and explicit volume removal', () => {
    const text = formatExample(example('k3s'));
    for (const fragment of ['orchestrator: k3s', 'private_host:', '"8080:3000"', 'x-dockflow:', 'size: 5Gi', 'dockflow volumes rm production', 'dockflow-my-app-production']) {
      assert.ok(text.includes(fragment), fragment);
    }
  });

  it('k3s-cluster: an odd manager count, workers, node labels and a placement constraint on them', () => {
    const ex = example('k3s-cluster');
    const servers = ex.files.find((f) => f.path === '.dockflow/servers.yml');
    assert.ok(servers);
    const doc = parseYaml(servers.content) as { servers: Record<string, { role?: string; private_host?: string; node_labels?: Record<string, string> }> };
    const entries = Object.values(doc.servers);
    assert.equal(entries.filter((s) => (s.role ?? 'manager') === 'manager').length, 3);
    assert.equal(entries.filter((s) => s.role === 'worker').length, 2);
    assert.ok(entries.every((s) => s.private_host !== undefined && s.node_labels?.zone !== undefined));
    assert.ok(formatExample(ex).includes('node.labels.zone =='));
  });

  it('k3s-helm: app and accessory releases, a pinned version and a rendered values file', () => {
    const ex = example('k3s-helm');
    const config = ex.files.find((f) => f.path === 'dockflow.yml');
    assert.ok(config);
    const doc = parseYaml(stubTemplates(config.content)) as { templates: string[]; helm: { releases: Array<Record<string, unknown>> } };
    const roles = doc.helm.releases.map((r) => r.role ?? 'app');
    assert.ok(roles.includes('app') && roles.includes('accessory'));
    const valuesFiles = doc.helm.releases.flatMap((r) => (r.values_files as string[] | undefined) ?? []);
    assert.ok(valuesFiles.length > 0);
    for (const file of valuesFiles) {
      assert.ok(doc.templates.includes(file), `${file} is rendered`);
      assert.ok(ex.files.some((f) => f.path === file), `${file} is part of the example`);
    }
    assert.ok(config.content.includes('{{ current.env.registry_password | dump }}'));
    assert.ok(ex.files.some((f) => f.path === 'docker-compose.yml'));
  });

  it('k3s-helm-only: no compose file, one app release and the day-2 commands that apply', () => {
    const ex = example('k3s-helm-only');
    assert.ok(!ex.files.some((f) => /docker-compose\.ya?ml$/.test(f.path)));
    const text = formatExample(ex);
    for (const fragment of ['dockflow status production', 'dockflow logs production podinfo', 'dockflow helm']) {
      assert.ok(text.includes(fragment), fragment);
    }
  });

  it('are listed with their titles', () => {
    const list = listExamples();
    for (const ex of EXAMPLES) assert.ok(list.includes(`**${ex.id}**`), ex.id);
  });
});
