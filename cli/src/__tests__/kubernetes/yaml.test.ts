import { describe, expect, it } from 'bun:test';
import { parseAllDocuments } from 'yaml';
import { canonicalJson, sha256Hex } from '../../utils/hash';
import { DeployError } from '../../utils/errors';
import type { ConfigMap, Secret, Service } from '../../services/orchestrator/kubernetes/resources/core';
import type { Deployment } from '../../services/orchestrator/kubernetes/resources/apps';
import type { ManifestObject } from '../../services/orchestrator/kubernetes/resources/registry';
import {
  ARTIFACT_FORMAT_LINE_PREFIX,
  type ArtifactHeader,
  artifactDigest,
  configMapValue,
  emitManifests,
  KEY_PRIORITY,
  parseManifests,
  readArtifactFormat,
  secretDataValue,
} from '../../services/orchestrator/kubernetes/yaml';
import { lineDiff } from './support/diff';
import { AMBIGUOUS_SCALARS } from './support/yaml-scalars';

const NS = 'dockflow-shop-production';
const header: ArtifactHeader = { format: 'k8s-manifests/1', stackName: 'shop-production', role: 'app', version: '1.4.2' };
const HEADER_TEXT = '# dockflow-artifact: k8s-manifests/1\n# stack: shop-production\n# role: app\n# version: 1.4.2\n';

function secret(name: string, data: Record<string, string> = { A: 'YQ==' }): Secret {
  return { apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: NS }, type: 'Opaque', immutable: true, data };
}

function configMap(name: string, data: Record<string, string>): ConfigMap {
  return { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace: NS }, data };
}

function service(name: string): Service {
  return {
    spec: { selector: { 'dockflow.shawiizz.dev/stack': NS, 'dockflow.shawiizz.dev/service': name }, ports: [{ protocol: 'TCP', port: 80, name: 'http' }] },
    metadata: { namespace: NS, name },
    kind: 'Service',
    apiVersion: 'v1',
  };
}

function deployment(name: string): Deployment {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace: NS, annotations: { 'dockflow.shawiizz.dev/release': '1.4.2' } },
    spec: {
      replicas: 2,
      selector: { matchLabels: { 'dockflow.shawiizz.dev/stack': NS, 'dockflow.shawiizz.dev/service': name } },
      template: {
        metadata: { labels: { 'dockflow.shawiizz.dev/service': name } },
        spec: { containers: [{ name, image: 'nginx:1.27', args: ['--level', 'yes'] }] },
      },
    },
  };
}

function documents(text: string): string[] {
  return text.split('---\n').slice(1);
}

describe('emitManifests (U-YAML-01)', () => {
  it('writes exactly the four header lines first', () => {
    const text = emitManifests([secret('a')], header);
    expect(text.startsWith(HEADER_TEXT)).toBe(true);
    expect(text.split('\n').slice(0, 4)).toEqual([
      `${ARTIFACT_FORMAT_LINE_PREFIX}k8s-manifests/1`,
      '# stack: shop-production',
      '# role: app',
      '# version: 1.4.2',
    ]);
    expect(text.split('\n')[4]).toBe('---');
  });

  it('writes `# version: -` for accessory artifacts whatever version is passed (rule 9)', () => {
    const text = emitManifests([secret('a')], { ...header, role: 'accessory', version: '9.9.9' });
    expect(text.split('\n').slice(2, 4)).toEqual(['# role: accessory', '# version: -']);
  });

  it('with no object, is the header alone with one trailing newline', () => {
    expect(emitManifests([], header)).toBe(HEADER_TEXT);
  });

  it('orders documents by kind rank, then metadata.name in code-unit order', () => {
    const objects: ManifestObject[] = [deployment('web'), service('web'), secret('b'), configMap('c', {}), secret('B'), secret('a')];
    const text = emitManifests(objects, header);
    const heads = documents(text).map((doc) => {
      const [, kind] = /kind: (\w+)/.exec(doc) ?? [];
      const [, name] = /\n {2}name: (\S+)/.exec(doc) ?? [];
      return `${kind}/${name}`;
    });
    expect(heads).toEqual(['Secret/B', 'Secret/a', 'Secret/b', 'ConfigMap/c', 'Service/web', 'Deployment/web']);
  });

  it('produces this exact text for a small artifact', () => {
    const text = emitManifests([service('web'), secret('web-env-3f9a1c2e')], header);
    const expected = [
      HEADER_TEXT,
      '---\n',
      'apiVersion: v1\n',
      'kind: Secret\n',
      'metadata:\n',
      '  name: web-env-3f9a1c2e\n',
      `  namespace: ${NS}\n`,
      'type: Opaque\n',
      'data:\n',
      '  A: YQ==\n',
      'immutable: true\n',
      '---\n',
      'apiVersion: v1\n',
      'kind: Service\n',
      'metadata:\n',
      '  name: web\n',
      `  namespace: ${NS}\n`,
      'spec:\n',
      '  ports:\n',
      '    - name: http\n',
      '      port: 80\n',
      '      protocol: TCP\n',
      '  selector:\n',
      '    dockflow.shawiizz.dev/service: web\n',
      `    dockflow.shawiizz.dev/stack: ${NS}\n`,
    ].join('');
    expect(lineDiff(expected, text)).toBe('');
  });

  it('applies KEY_PRIORITY then code-unit order in every mapping, at every depth', () => {
    expect(KEY_PRIORITY).toEqual(['apiVersion', 'kind', 'metadata', 'name', 'namespace', 'type']);
    const text = emitManifests([configMap('c', { b: '1', B: '2', _: '3', a: '4', name: '5', type: '6' })], header);
    expect(documents(text)[0]).toBe(
      [
        'apiVersion: v1',
        'kind: ConfigMap',
        'metadata:',
        '  name: c',
        `  namespace: ${NS}`,
        'data:',
        '  name: "5"',
        '  type: "6"',
        '  B: "2"',
        '  _: "3"',
        '  a: "4"',
        '  b: "1"',
        '',
      ].join('\n'),
    );
  });

  it('output does not depend on object construction order', () => {
    const a = service('web');
    const b: Service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'web', namespace: NS },
      spec: { ports: [{ name: 'http', port: 80, protocol: 'TCP' }], selector: { 'dockflow.shawiizz.dev/service': 'web', 'dockflow.shawiizz.dev/stack': NS } },
    };
    expect(emitManifests([a], header)).toBe(emitManifests([b], header));
  });

  it('writes multi-line strings as block literals', () => {
    const text = emitManifests([configMap('c', { 'nginx.conf': 'server {\n  listen 80;\n}\n', 'no-newline': 'a\nb' })], header);
    expect(text).toContain('  nginx.conf: |\n    server {\n      listen 80;\n    }\n');
    expect(text).toContain('  no-newline: |-\n    a\n    b\n');
  });

  it('quotes every ambiguous scalar so it reads back as the same string', () => {
    const data: Record<string, string> = {};
    AMBIGUOUS_SCALARS.forEach((value, i) => {
      data[`k${i}`] = value;
    });
    const text = emitManifests([configMap('c', data)], header);
    expect(parseManifests(text)).toEqual([configMap('c', data)]);
  });

  it('quotes strings YAML 1.1 (kubectl) would read as booleans, numbers or timestamps, keys included', () => {
    const data = { yes: 'on', Y: 'n', NO: 'Off', binary: '0b101', grouped: '1_000', time: '1:30', date: '2001-12-14', plain: 'hello world' };
    const text = emitManifests([configMap('c', data)], header);
    for (const line of ['"yes": "on"', '"Y": "n"', '"NO": "Off"', 'binary: "0b101"', 'grouped: "1_000"', 'time: "1:30"', 'date: "2001-12-14"', 'plain: hello world']) {
      expect(text).toContain(`  ${line}\n`);
    }
    const args = emitManifests([deployment('web')], header);
    expect(args).toContain('- "yes"\n');
  });

  it('quotes a << key, which YAML 1.1 reads as a merge key', () => {
    const text = emitManifests([configMap('c', { '<<': 'x' })], header);
    expect(text).toContain('  "<<": x\n');
    expect(parseAllDocuments(text, { version: '1.1' })[0].toJS()).toEqual(configMap('c', { '<<': 'x' }));
  });

  it('never writes a tab, and ends the file with exactly one newline', () => {
    const text = emitManifests([configMap('c', { tab: 'a\tb', multi: 'x\ty\nz', blank: 'a\n\n', only: '\n', end: 'z\n\n\n' })], header);
    expect(text).not.toContain('\t');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(parseManifests(text)[0]).toEqual(configMap('c', { tab: 'a\tb', multi: 'x\ty\nz', blank: 'a\n\n', only: '\n', end: 'z\n\n\n' }));
  });

  it('drops undefined properties and writes no anchors for a shared object', () => {
    const selector = { 'dockflow.shawiizz.dev/stack': NS, 'dockflow.shawiizz.dev/service': 'web' };
    const svc = service('web');
    svc.spec.selector = selector;
    const dep = deployment('web');
    dep.spec.selector = { matchLabels: selector };
    dep.spec.minReadySeconds = undefined;
    const text = emitManifests([svc, dep], header);
    expect(text).not.toContain('&');
    expect(text).not.toContain('*');
    expect(text).not.toContain('minReadySeconds');
  });

  it('keeps empty maps and lists the translator put there', () => {
    const text = emitManifests([configMap('c', {})], header);
    expect(text).toContain('data: {}\n');
  });

  it('throws a DeployError for null values, unknown kinds and missing names (translator bugs)', () => {
    const withNull = configMap('c', {});
    (withNull as unknown as { data: unknown }).data = null;
    expect(() => emitManifests([withNull], header)).toThrow(DeployError);
    const namespace = { apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } } as unknown as ManifestObject;
    expect(() => emitManifests([namespace], header)).toThrow(DeployError);
    const unnamed = { ...secret('x'), metadata: { name: '' } };
    expect(() => emitManifests([unnamed], header)).toThrow(DeployError);
    const infinite = configMap('c', {});
    (infinite as unknown as { spec: unknown }).spec = { n: Number.POSITIVE_INFINITY };
    expect(() => emitManifests([infinite], header)).toThrow(DeployError);
  });

  it('is byte-identical across calls (rule 9)', () => {
    const objects = [deployment('web'), service('web'), secret('s')];
    expect(emitManifests(objects, header)).toBe(emitManifests([...objects].reverse(), header));
  });
});

describe('readArtifactFormat (U-YAML-02)', () => {
  it('reads the header line', () => {
    expect(readArtifactFormat(emitManifests([secret('a')], header))).toBe('k8s-manifests/1');
    expect(readArtifactFormat('# dockflow-artifact: swarm-compose/1\nservices: {}\n')).toBe('swarm-compose/1');
  });

  it('content without the header line is a Swarm release from before the rewrite', () => {
    expect(readArtifactFormat('services:\n  web:\n    image: nginx\n')).toBe('swarm-compose/1');
    expect(readArtifactFormat('')).toBe('swarm-compose/1');
    expect(readArtifactFormat('# stack: x\n# dockflow-artifact: k8s-manifests/1\n')).toBe('swarm-compose/1');
  });

  it('tolerates CRLF line endings and a byte order mark', () => {
    expect(readArtifactFormat('# dockflow-artifact: k8s-manifests/1\r\n# stack: x\r\n')).toBe('k8s-manifests/1');
    expect(readArtifactFormat('\u{feff}# dockflow-artifact: k8s-manifests/1\n')).toBe('k8s-manifests/1');
  });

  it('refuses a format this version does not know', () => {
    expect(() => readArtifactFormat('# dockflow-artifact: k8s-manifests/2\n')).toThrow(DeployError);
  });
});

describe('parseManifests (U-YAML-03)', () => {
  it('reads emitted manifests back', () => {
    const objects: ManifestObject[] = [secret('s'), service('web'), deployment('web')];
    expect(parseManifests(emitManifests(objects, header))).toEqual(objects);
  });

  it('skips empty documents and comment-only content', () => {
    expect(parseManifests(HEADER_TEXT)).toEqual([]);
    expect(parseManifests('')).toEqual([]);
    expect(parseManifests('---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: a\n---\n')).toHaveLength(1);
  });

  it('throws DeployError on invalid YAML', () => {
    expect(() => parseManifests('---\nkind: [Secret\n')).toThrow(DeployError);
    expect(() => parseManifests('---\na: 1\na: 2\n')).toThrow(DeployError);
  });

  it('throws DeployError on a document that is not an object', () => {
    expect(() => parseManifests('---\n- a\n- b\n')).toThrow(DeployError);
    expect(() => parseManifests('---\njust a string\n')).toThrow(DeployError);
    expect(() => parseManifests('---\n42\n')).toThrow(DeployError);
  });

  it('parses the emitted header as comments of the first document', () => {
    const text = emitManifests([secret('s')], header);
    const docs = parseAllDocuments(text);
    expect(docs).toHaveLength(1);
  });
});

describe('artifactDigest (rule 10)', () => {
  it('is sha256Hex(content + "\\n" + canonicalJson(helm))', () => {
    const content = emitManifests([secret('s')], header);
    expect(artifactDigest(content, [])).toBe(sha256Hex(`${content}\n[]`));
    const helm = [{ name: 'cache', b: 1, a: [2, 1] }] as unknown as Parameters<typeof artifactDigest>[1];
    expect(artifactDigest(content, helm)).toBe(sha256Hex(`${content}\n${canonicalJson(helm)}`));
    expect(artifactDigest(content, helm)).not.toBe(artifactDigest(content, []));
  });
});

describe('Secret and ConfigMap payloads (rule 7)', () => {
  it('Secret data is base64 of the raw bytes', () => {
    expect(secretDataValue('a')).toBe('YQ==');
    expect(secretDataValue('é')).toBe('w6k=');
    expect(secretDataValue(new Uint8Array([0xff, 0x00]))).toBe('/wA=');
  });

  it('ConfigMap content goes to data when it is UTF-8 and to binaryData otherwise', () => {
    expect(configMapValue(new TextEncoder().encode('key = "é"\n'))).toEqual({ field: 'data', value: 'key = "é"\n' });
    expect(configMapValue(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toEqual({ field: 'data', value: '\u{feff}a' });
    expect(configMapValue(new Uint8Array([0xff, 0xfe, 0x00]))).toEqual({ field: 'binaryData', value: '//4A' });
  });
});

describe('support/diff lineDiff', () => {
  it('is empty for equal texts', () => {
    expect(lineDiff('a\nb\n', 'a\nb\n')).toBe('');
  });

  it('shows a changed line with context and 1-based hunk ranges', () => {
    const expected = ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n');
    const actual = ['1', '2', '3', '4', 'five', '6', '7', '8'].join('\n');
    expect(lineDiff(expected, actual)).toBe(
      ['--- expected', '+++ actual', '@@ -2,7 +2,7 @@', ' 2', ' 3', ' 4', '-5', '+five', ' 6', ' 7', ' 8', ''].join('\n'),
    );
  });

  it('shows insertions, deletions and separate hunks', () => {
    const expected = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const lines = expected.split('\n');
    lines.splice(15, 1);
    lines.splice(2, 0, 'inserted');
    const diff = lineDiff(expected, lines.join('\n'), { context: 1, labels: { expected: 'golden', actual: 'rendered' } });
    expect(diff).toBe(
      [
        '--- golden',
        '+++ rendered',
        '@@ -2,2 +2,3 @@',
        ' line 1',
        '+inserted',
        ' line 2',
        '@@ -15,3 +16,2 @@',
        ' line 14',
        '-line 15',
        ' line 16',
        '',
      ].join('\n'),
    );
  });

  it('handles empty sides and a missing final newline', () => {
    expect(lineDiff('', 'a')).toBe(['--- expected', '+++ actual', '@@ -0,0 +1,1 @@', '+a', ''].join('\n'));
    expect(lineDiff('a\n', 'a')).toBe(['--- expected', '+++ actual', '@@ -1,2 +1,1 @@', ' a', '-', ''].join('\n'));
  });

  it('falls back to a whole replacement when the texts share nothing', () => {
    const a = Array.from({ length: 1500 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 1500 }, (_, i) => `b${i}`).join('\n');
    const diff = lineDiff(a, b, { context: 0 });
    expect(diff.split('\n').filter((l) => l.startsWith('-a')).length).toBe(1500);
    expect(diff.split('\n').filter((l) => l.startsWith('+b')).length).toBe(1500);
  });
});
