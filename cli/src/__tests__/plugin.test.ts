import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  applyPluginExpansion,
  expandPlugins,
  parseManifest,
  pluginRelPath,
  resolveInputs,
  resolvePluginSource,
  type PluginExpansion,
} from '../services/plugin';
import { DOCKFLOW_PLUGIN_INSTANCES_DIR } from '../constants';
import type { DockflowConfig } from '../utils/config';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const dirs: string[] = [];

function project(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dockflow-plugin-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const WEB_MANIFEST = `name: web
inputs:
  domain: { required: true }
  port: { default: "3000" }
  template: { type: file, default: vhost.conf }
uploads:
  - src: "{{ inputs.template }}"
    dest: "/etc/nginx/sites-enabled/{{ inputs.domain }}.conf"
hooks:
  post-upload:
    - name: reload
      run: nginx -s reload
      fatal: true
`;

const WEB_VHOST = 'server_name {{ inputs.domain }}; proxy_pass 127.0.0.1:{{ inputs.port }};';

/** A project holding the `web` plugin locally. */
function webProject(extra: Record<string, string> = {}): string {
  return project({
    '.dockflow/plugins/web/plugin.yml': WEB_MANIFEST,
    '.dockflow/plugins/web/vhost.conf': WEB_VHOST,
    ...extra,
  });
}

const context = { env: 'production', version: '1.2.3', project_name: 'demo' };

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

describe('resolveInputs', () => {
  const manifest = parseManifest(WEB_MANIFEST, 'test');

  it('refuses a missing required input', () => {
    expect(() => resolveInputs(manifest, {}, 'plugin web')).toThrow(/missing required input\(s\): domain/);
  });

  it('applies defaults and lets given values win', () => {
    const values = resolveInputs(manifest, { domain: 'a.example.com', port: 8080 }, 'plugin web');

    expect(values.domain).toBe('a.example.com');
    expect(values.port).toBe('8080');
  });

  it('refuses an input the plugin does not declare, so a typo is not silently ignored', () => {
    expect(() => resolveInputs(manifest, { domain: 'a', prot: '1' }, 'plugin web')).toThrow(/unknown input\(s\): prot/);
  });

  it('a file input remembers where its path resolves from', () => {
    expect(resolveInputs(manifest, { domain: 'a' }, 'w').template).toBe('plugin:vhost.conf');
    expect(resolveInputs(manifest, { domain: 'a', template: 'mine.conf' }, 'w').template).toBe('project:mine.conf');
  });
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe('parseManifest', () => {
  it('accepts the same uploads and hooks shape as config.yml', () => {
    const manifest = parseManifest(WEB_MANIFEST, 'test');

    expect(manifest.name).toBe('web');
    expect(manifest.uploads).toHaveLength(1);
    expect(manifest.hooks?.['post-upload']).toHaveLength(1);
  });

  it('refuses project-level keys a plugin has no business setting', () => {
    expect(() => parseManifest('name: web\nproject_name: hijack\n', 'test')).toThrow(/invalid plugin\.yml/);
  });

  it('refuses a hook entry with both run and script', () => {
    const text = 'name: web\nhooks:\n  post-upload:\n    - { run: a, script: b.sh }\n';

    expect(() => parseManifest(text, 'test')).toThrow(/exactly one of `run` or `script`/);
  });

  it('reports invalid YAML as such', () => {
    expect(() => parseManifest('name: [unclosed', 'test')).toThrow(/not valid YAML/);
  });
});

describe('pluginRelPath', () => {
  it('keeps paths inside the plugin', () => {
    expect(pluginRelPath('conf/vhost.conf', 'w')).toBe('conf/vhost.conf');
    expect(pluginRelPath('a/../b.conf', 'w')).toBe('b.conf');
  });

  it('refuses paths that leave the plugin', () => {
    expect(() => pluginRelPath('../../.env.dockflow', 'w')).toThrow(/stay inside the plugin/);
    expect(() => pluginRelPath('a/../../x', 'w')).toThrow(/stay inside the plugin/);
    expect(() => pluginRelPath('/etc/passwd', 'w')).toThrow(/stay inside the plugin/);
  });
});

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

describe('resolvePluginSource', () => {
  it('finds a bare name among the project plugins', () => {
    const source = resolvePluginSource('web', webProject(), {});

    expect(source.origin).toBe('local');
    expect(source.location).toBe('.dockflow/plugins/web');
  });

  it('falls back to a built-in plugin', () => {
    const root = project({ 'lib/plugin.yml': 'name: lib\n' });
    const source = resolvePluginSource('lib', root, { lib: { 'plugin.yml': join(root, 'lib/plugin.yml') } });

    expect(source.origin).toBe('builtin');
  });

  it('a project plugin shadows the built-in plugin of the same name', () => {
    const root = webProject({ 'builtin/plugin.yml': 'name: web\n' });
    const source = resolvePluginSource('web', root, { web: { 'plugin.yml': join(root, 'builtin/plugin.yml') } });

    expect(source.origin).toBe('local');
  });

  it('resolves an explicit path from the project root', () => {
    const root = project({ 'vendor/web/plugin.yml': WEB_MANIFEST });

    expect(resolvePluginSource('./vendor/web', root, {}).location).toBe('./vendor/web');
  });

  it('names the available plugins when a name is unknown', () => {
    expect(() => resolvePluginSource('nope', project(), { nginx: {} })).toThrow(/unknown plugin: nope/);
  });

  it('refuses a bare reference that is neither a name nor a path', () => {
    expect(() => resolvePluginSource('vendor/web', project(), {})).toThrow(/invalid plugin reference/);
  });
});

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

describe('expandPlugins', () => {
  it('renders the plugin file with its inputs and points the upload at it', async () => {
    const root = webProject();
    const expansion = await expandPlugins(
      [{ use: 'web', with: { domain: 'api.example.com' } }],
      { projectRoot: root, projectContext: context, builtins: {} },
    );

    const [upload] = expansion.uploads;
    expect(upload.dest).toBe('/etc/nginx/sites-enabled/api.example.com.conf');
    expect(upload.src).toBe(`${DOCKFLOW_PLUGIN_INSTANCES_DIR}/web/plugin/vhost.conf`);
    expect(expansion.files.get(upload.src)).toBe('server_name api.example.com; proxy_pass 127.0.0.1:3000;');
  });

  it('two instances of one plugin keep their own rendered files', async () => {
    const root = webProject();
    const expansion = await expandPlugins(
      [
        { use: 'web', id: 'api', with: { domain: 'api.example.com', port: '3000' } },
        { use: 'web', id: 'admin', with: { domain: 'admin.example.com', port: '4000' } },
      ],
      { projectRoot: root, projectContext: context, builtins: {} },
    );

    const [api, admin] = expansion.uploads;
    expect(api.src).not.toBe(admin.src);
    expect(expansion.files.get(api.src)).toContain('api.example.com');
    expect(expansion.files.get(api.src)).toContain(':3000');
    expect(expansion.files.get(admin.src)).toContain('admin.example.com');
    expect(expansion.files.get(admin.src)).toContain(':4000');
  });

  it('refuses one id for two instances', async () => {
    const expand = expandPlugins(
      [{ use: 'web', with: { domain: 'a' } }, { use: 'web', with: { domain: 'b' } }],
      { projectRoot: webProject(), projectContext: context, builtins: {} },
    );

    await expect(expand).rejects.toThrow(/plugin id "web" is used twice/);
  });

  it('a project override file sees the project context and the plugin inputs', async () => {
    const root = webProject({ '.dockflow/nginx/mine.conf': '{{ inputs.domain }} {{ env }} {{ current.env.extra }}' });
    const expansion = await expandPlugins(
      [{ use: 'web', with: { domain: 'api.example.com', template: '.dockflow/nginx/mine.conf' } }],
      { projectRoot: root, projectContext: { ...context, current: { env: { extra: 'custom' } } }, builtins: {} },
    );

    const [upload] = expansion.uploads;
    expect(upload.src).toBe(`${DOCKFLOW_PLUGIN_INSTANCES_DIR}/web/project/.dockflow/nginx/mine.conf`);
    expect(expansion.files.get(upload.src)).toBe('api.example.com production custom');
  });

  it('a plugin file cannot reach the project variables, even ones that exist', async () => {
    const root = webProject();
    writeFileSync(join(root, '.dockflow/plugins/web/vhost.conf'), '{{ current.env.secret }}');
    const expand = expandPlugins(
      [{ use: 'web', with: { domain: 'a' } }],
      { projectRoot: root, projectContext: { ...context, current: { env: { secret: 'LEAK' } } }, builtins: {} },
    );

    await expect(expand).rejects.toThrow(/attempted to output null or undefined value/);
  });

  it('names hook entries after their instance', async () => {
    const expansion = await expandPlugins(
      [{ use: 'web', id: 'api', with: { domain: 'a' } }],
      { projectRoot: webProject(), projectContext: context, builtins: {} },
    );

    expect(expansion.hooks['post-upload']).toEqual([{ name: 'web[api] reload', run: 'nginx -s reload', fatal: true }]);
  });

  it('materializes a script entry like an upload', async () => {
    const root = project({
      '.dockflow/plugins/job/plugin.yml': 'name: job\nhooks:\n  pre-deploy:\n    - script: run.sh\n',
      '.dockflow/plugins/job/run.sh': 'echo {{ project_name }}',
    });
    const expansion = await expandPlugins([{ use: 'job' }], { projectRoot: root, projectContext: context, builtins: {} });

    const [entry] = expansion.hooks['pre-deploy'] ?? [];
    const script = typeof entry === 'string' ? '' : entry.script ?? '';
    expect(expansion.files.get(script)).toBe('echo demo');
  });

  it('refuses a dest that renders to a relative path', async () => {
    const root = project({
      '.dockflow/plugins/bad/plugin.yml': 'name: bad\nuploads:\n  - src: a.conf\n    dest: "{{ project_name }}/a.conf"\n',
      '.dockflow/plugins/bad/a.conf': 'x',
    });
    const expand = expandPlugins([{ use: 'bad' }], { projectRoot: root, projectContext: context, builtins: {} });

    await expect(expand).rejects.toThrow(/must be an absolute path/);
  });

  it('refuses a plugin file reference that leaves the plugin', async () => {
    const root = project({
      '.env.dockflow': 'SECRET=1',
      '.dockflow/plugins/leak/plugin.yml': 'name: leak\nuploads:\n  - src: ../../../.env.dockflow\n    dest: /tmp/leak\n',
    });
    const expand = expandPlugins([{ use: 'leak' }], { projectRoot: root, projectContext: context, builtins: {} });

    await expect(expand).rejects.toThrow(/stay inside the plugin/);
  });
});

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

describe('applyPluginExpansion', () => {
  const empty = (): PluginExpansion => ({ uploads: [], hooks: {}, files: new Map(), summary: [] });
  const base = { project_name: 'demo' } as DockflowConfig;

  it('runs plugin entries before the project entries of the same phase', () => {
    const expansion = empty();
    expansion.hooks['post-upload'] = [{ name: 'web reload', run: 'reload' }];
    const config = applyPluginExpansion(
      { ...base, hooks: { 'post-upload': ['project step'] } },
      new Map(),
      expansion,
      project(),
    );

    expect(config.hooks?.['post-upload']).toEqual([{ name: 'web reload', run: 'reload' }, 'project step']);
  });

  it('refuses two uploads writing the same path', () => {
    const expansion = empty();
    expansion.uploads.push({ src: `${DOCKFLOW_PLUGIN_INSTANCES_DIR}/web/plugin/vhost.conf`, dest: '/etc/nginx/sites-enabled/a.conf' });
    expansion.files.set(`${DOCKFLOW_PLUGIN_INSTANCES_DIR}/web/plugin/vhost.conf`, 'x');

    expect(() => applyPluginExpansion(
      { ...base, uploads: [{ src: 'mine.conf', dest: '/etc/nginx/sites-enabled/a.conf' }] },
      new Map(),
      expansion,
      project({ 'mine.conf': 'y' }),
    )).toThrow(/two uploads write \/etc\/nginx\/sites-enabled\/a\.conf/);
  });

  it('two files uploaded into one directory are not a clash', () => {
    const root = project({ 'a.conf': 'a', 'b.conf': 'b' });

    expect(() => applyPluginExpansion(
      { ...base, uploads: [{ src: 'a.conf', dest: '/etc/app/' }, { src: 'b.conf', dest: '/etc/app/' }] },
      new Map(),
      empty(),
      root,
    )).not.toThrow();
  });

  it('adds the rendered plugin files to the rendered map', () => {
    const rendered = new Map<string, string>();
    const expansion = empty();
    expansion.files.set('k', 'v');
    applyPluginExpansion(base, rendered, expansion, project());

    expect(rendered.get('k')).toBe('v');
  });
});

// ---------------------------------------------------------------------------
// Built-in plugins
// ---------------------------------------------------------------------------

describe('built-in plugins', () => {
  it('nginx renders a vhost for the domain and port', async () => {
    const expansion = await expandPlugins(
      [{ use: 'nginx', with: { domain: 'api.example.com', port: 24001 } }],
      { projectRoot: project(), projectContext: context },
    );

    const [upload] = expansion.uploads;
    const vhost = expansion.files.get(upload.src) ?? '';
    expect(upload.dest).toBe('/etc/nginx/sites-enabled/api.example.com.conf');
    expect(vhost).toContain('server_name api.example.com;');
    expect(vhost).toContain('proxy_pass http://127.0.0.1:24001;');
    expect(vhost).toContain('listen 80;');
    expect(expansion.hooks['post-upload']).toEqual([
      { name: 'nginx reload', run: 'sudo nginx -t && sudo nginx -s reload', fatal: true, timeout: 30 },
    ]);
  });

  it('nginx reloads again after a failed deploy, so the restored vhost is served', async () => {
    const expansion = await expandPlugins(
      [{ use: 'nginx', with: { domain: 'a.example.com', port: 3000 } }],
      { projectRoot: project(), projectContext: context },
    );

    expect(expansion.hooks['on-failure']).toEqual([
      { name: 'nginx restore', run: 'sudo nginx -t && sudo nginx -s reload', timeout: 30 },
    ]);
  });

  it('systemd installs the unit from the project under its systemd name', async () => {
    const root = project({ '.dockflow/services/app.service': '[Service]\nExecStart=/bin/true\n' });
    const expansion = await expandPlugins(
      [{ use: 'systemd', with: { unit: '.dockflow/services/app.service', name: 'app.service' } }],
      { projectRoot: root, projectContext: context },
    );

    const [upload] = expansion.uploads;
    expect(upload.dest).toBe('/etc/systemd/system/app.service');
    expect(expansion.files.get(upload.src)).toContain('ExecStart=/bin/true');
    expect(expansion.hooks['post-upload']?.[0]).toMatchObject({
      name: 'systemd enable',
      run: 'sudo systemctl daemon-reload && sudo systemctl enable --now app.service',
    });
  });

  it('systemd requires both inputs', async () => {
    const expand = expandPlugins([{ use: 'systemd', with: { name: 'app.service' } }], {
      projectRoot: project(),
      projectContext: context,
    });

    await expect(expand).rejects.toThrow(/missing required input\(s\): unit/);
  });
});
