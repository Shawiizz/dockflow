import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { EXAMPLES, formatExample, listExamples, SCENARIO_DESCRIPTION } from '../examples.js';
import { validateFile } from '../validate.js';
import { withCliVersion } from '../version.js';

const isYaml = (path: string): boolean => /\.ya?ml$/.test(path);
const basename = (path: string): string => path.split('/').pop() ?? path;

/** The names a Dockflow template can start from: the render context of a deploy (services/compose/templates.ts) */
const RENDER_VARIABLES = ['env', 'version', 'branch', 'project_name', 'config', 'current', 'servers', 'cluster'];

describe('get_examples', () => {
  it('has unique ids and names them all in the description of its scenario argument', () => {
    const ids = EXAMPLES.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(SCENARIO_DESCRIPTION, `Scenario id: ${ids.join(', ')}. Omit to list all.`);
  });

  it('lists every example with its title', () => {
    const list = listExamples();
    for (const ex of EXAMPLES) {
      assert.ok(list.includes(`**${ex.id}** — ${ex.title}`), ex.id);
    }
  });

  it('shows the title, the description and every file of an example', () => {
    for (const ex of EXAMPLES) {
      const text = formatExample(ex);
      assert.ok(text.startsWith(`## ${ex.title}\n`), ex.id);
      assert.ok(text.includes(ex.description), ex.id);
      for (const file of ex.files) assert.ok(text.includes(`### \`${file.path}\``), `${ex.id}: ${file.path}`);
    }
  });

  for (const ex of EXAMPLES) {
    describe(ex.id, () => {
      it('has no two files at one path', () => {
        const paths = ex.files.map((f) => f.path);
        assert.equal(new Set(paths).size, paths.length);
      });

      for (const file of ex.files.filter((f) => isYaml(f.path))) {
        it(`${file.path} parses as YAML`, () => {
          assert.doesNotThrow(() => parseYaml(file.content));
        });
      }

      for (const file of ex.files) {
        const name = basename(file.path);
        if (name === 'dockflow.yml') {
          it(`${file.path} passes validate_config`, () => {
            assert.deepEqual(validateFile(file.content, 'root').errors, []);
          });
        }
        if (name === 'config.yml') {
          it(`${file.path} passes validate_config`, () => {
            assert.deepEqual(validateFile(file.content, 'config').errors, []);
          });
        }
        if (name === 'servers.yml') {
          it(`${file.path} passes validate_config`, () => {
            assert.deepEqual(validateFile(file.content, 'servers').errors, []);
          });
        }
      }

      it('only uses template variables the render context has', () => {
        // .github/ files are rendered by GitHub, not by Dockflow
        for (const file of ex.files.filter((f) => isYaml(f.path) && !f.path.startsWith('.github/'))) {
          for (const match of file.content.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
            assert.ok(RENDER_VARIABLES.includes(match[1]), `${file.path}: {{ ${match[1]} ... }}`);
          }
        }
      });
    });
  }
});

describe('the version placeholder of the examples', () => {
  it('is replaced by the latest release', async () => {
    mock.method(globalThis, 'fetch', async () => Response.json({ version: '9.8.7' }));
    for (const ex of EXAMPLES) {
      const text = await withCliVersion(formatExample(ex));
      assert.ok(!text.includes('__DOCKFLOW_VERSION__'), ex.id);
    }
    const ci = EXAMPLES.find((e) => e.id === 'with-ci');
    assert.ok(ci);
    assert.ok((await withCliVersion(formatExample(ci))).includes('@dockflow-tools/cli@9.8.7'));
  });
});
