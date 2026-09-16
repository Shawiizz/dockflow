import { describe, expect, it } from 'bun:test';
import { describeUndefinedEnvReferences, findUndefinedEnvReferences } from '../services/template-lint';

describe('findUndefinedEnvReferences', () => {
  it('reports a written reference to a key that is not declared, with its line', () => {
    const found = findUndefinedEnvReferences('a: 1\nkey: {{ current.env.secret_key }}', ['app_port']);

    expect(found).toEqual([{ name: 'secret_key', line: 2, suggestion: undefined }]);
  });

  it('ignores declared keys', () => {
    expect(findUndefinedEnvReferences('{{ current.env.app_port }}', ['app_port'])).toEqual([]);
  });

  it('catches the bracket form too', () => {
    expect(findUndefinedEnvReferences('{{ current.env["secret"] }}', []).map((r) => r.name)).toEqual(['secret']);
  });

  it('a default is a deliberate optional value', () => {
    expect(findUndefinedEnvReferences('{{ current.env.port | default("3000") }}', [])).toEqual([]);
    expect(findUndefinedEnvReferences('{{ current.env.port | d("3000") }}', [])).toEqual([]);
  });

  it('an `or` fallback is a deliberate optional value', () => {
    expect(findUndefinedEnvReferences('{{ current.env.port or "3000" }}', [])).toEqual([]);
  });

  it('a condition only tests the key, and writes nothing', () => {
    expect(findUndefinedEnvReferences('{% if current.env.debug %}on{% endif %}', [])).toEqual([]);
    expect(findUndefinedEnvReferences('{{ "on" if current.env.debug else "off" }}', [])).toEqual([]);
  });

  it('a reference written inside a conditional block still counts', () => {
    const found = findUndefinedEnvReferences('{% if env == "production" %}\nkey={{ current.env.prod_key }}\n{% endif %}', []);

    expect(found).toEqual([{ name: 'prod_key', line: 2, suggestion: undefined }]);
  });

  it('points at the lowercase key when only the case differs', () => {
    const [found] = findUndefinedEnvReferences('{{ current.env.DB_HOST }}', ['db_host']);

    expect(found.suggestion).toBe('db_host');
  });

  it('reports every occurrence', () => {
    const found = findUndefinedEnvReferences('{{ current.env.a }}\n{{ current.env.b }}\n{{ current.env.a }}', []);

    expect(found.map((r) => `${r.name}:${r.line}`)).toEqual(['a:1', 'b:2', 'a:3']);
  });

  it('leaves variables other than current.env alone', () => {
    expect(findUndefinedEnvReferences('{{ env }} {{ version }} {{ config.project_name }} {{ current.name }}', [])).toEqual([]);
  });

  it('a template that does not parse yields nothing, rendering reports it', () => {
    expect(findUndefinedEnvReferences('{{ current.env.a ', [])).toEqual([]);
  });

  it('catches the hook that wrote an empty key', () => {
    const hook = "mkdir -p /home/{{ current.user }}/.ssh\nprintf '%s' '{{ current.env.ssh_private_key_vm_oracle }}' > key";

    expect(findUndefinedEnvReferences(hook, ['app_external_port'])).toEqual([
      { name: 'ssh_private_key_vm_oracle', line: 2, suggestion: undefined },
    ]);
  });
});

describe('describeUndefinedEnvReferences', () => {
  it('names the file, line, key and server, and how to fix it', () => {
    const [line] = describeUndefinedEnvReferences('.dockflow/hooks/key.sh', [{ name: 'deploy_key', line: 3 }], 'main_server');

    expect(line).toContain('.dockflow/hooks/key.sh:3');
    expect(line).toContain('current.env.deploy_key is not defined for main_server');
    expect(line).toContain('servers.yml');
  });

  it('suggests the lowercase key when that is the problem', () => {
    const [line] = describeUndefinedEnvReferences('a.yml', [{ name: 'DB_HOST', line: 1, suggestion: 'db_host' }], 'main');

    expect(line).toContain('use current.env.db_host');
  });
});
