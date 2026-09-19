// translate/registry-secret.ts (DESIGN-CORE 5.5; design-03 12.3): the `dockflow-registry`
// dockerconfigjson Secret, validated with support/schema (PD-11 (e)); the credentials live in its
// data only.

import { describe, expect, test } from 'bun:test';
import { REGISTRY_PULL_SECRET_NAME } from '../../../constants';
import type { RegistryCredentials } from '../../../services/orchestrator/interfaces';
import { K8S_REGISTRY_SECRET, LABELS } from '../../../services/orchestrator/kubernetes/constants';
import {
  DOCKER_HUB_CONFIG_SERVER,
  dockerConfigAuth,
  dockerConfigJson,
  dockerConfigServer,
  registrySecret,
  registrySecretRedactions,
} from '../../../services/orchestrator/kubernetes/translate/registry-secret';
import { Redactor } from '../../../utils/redact';
import { stackRef } from '../support/builders';
import { failures, formatIssues, validateSemantics } from '../support/schema/semantic';
import { validateObject } from '../support/schema/validate';

const P = 'dockflow.shawiizz.dev';
const NS = 'dockflow-shop-production';
const CREDENTIALS: RegistryCredentials = { server: 'https://registry.example.com', username: 'deploy-bot', password: 'pa55-w0rd-registry' };

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

describe('dockerConfigServer (design-03 12.3)', () => {
  test('strips scheme and path, keeps host and port', () => {
    expect(dockerConfigServer('registry.example.com')).toBe('registry.example.com');
    expect(dockerConfigServer('https://registry.example.com/')).toBe('registry.example.com');
    expect(dockerConfigServer('http://registry.example.com:5000/v2/')).toBe('registry.example.com:5000');
    expect(dockerConfigServer('registry.example.com:5000/team/app')).toBe('registry.example.com:5000');
    expect(dockerConfigServer('  https://registry.example.com  ')).toBe('registry.example.com');
  });

  test('every Docker Hub alias maps to the key Docker writes', () => {
    for (const server of ['docker.io', 'index.docker.io', 'registry-1.docker.io', 'https://index.docker.io/v1/', 'https://registry-1.docker.io', 'Docker.IO']) {
      expect(dockerConfigServer(server)).toBe(DOCKER_HUB_CONFIG_SERVER);
    }
    expect(DOCKER_HUB_CONFIG_SERVER).toBe('https://index.docker.io/v1/');
  });
});

describe('dockerConfigJson (design-03 12.3)', () => {
  test('is the canonical JSON of auths with auth, password and username', () => {
    const auth = b64('deploy-bot:pa55-w0rd-registry');
    expect(dockerConfigAuth(CREDENTIALS)).toBe(auth);
    expect(dockerConfigJson(CREDENTIALS)).toBe(
      `{"auths":{"registry.example.com":{"auth":"${auth}","password":"pa55-w0rd-registry","username":"deploy-bot"}}}`,
    );
  });

  test('an empty username keeps the `:password` auth form', () => {
    const credentials = { ...CREDENTIALS, username: '' };
    expect(dockerConfigAuth(credentials)).toBe(b64(':pa55-w0rd-registry'));
    expect(JSON.parse(dockerConfigJson(credentials)).auths['registry.example.com'].username).toBe('');
  });

  test('is byte-stable for the same credentials', () => {
    expect(dockerConfigJson({ ...CREDENTIALS })).toBe(dockerConfigJson(CREDENTIALS));
  });
});

describe('registrySecret (DESIGN-CORE 5.5, design-03 12.3)', () => {
  test('is the object of design-03 12.3, exactly', () => {
    const config = dockerConfigJson(CREDENTIALS);
    expect(registrySecret(stackRef(), config)).toEqual({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: 'dockflow-registry',
        namespace: NS,
        labels: {
          'app.kubernetes.io/instance': NS,
          'app.kubernetes.io/managed-by': 'dockflow',
          'app.kubernetes.io/part-of': 'shop',
          [`${P}/part`]: 'registry',
          [`${P}/stack`]: NS,
        },
      },
      type: 'kubernetes.io/dockerconfigjson',
      data: { '.dockerconfigjson': b64(config) },
    });
  });

  test('is neither immutable nor content-named, and has no role label', () => {
    const secret = registrySecret(stackRef(), dockerConfigJson(CREDENTIALS));
    expect(secret).not.toHaveProperty('immutable');
    expect(secret.metadata.name).toBe(K8S_REGISTRY_SECRET);
    expect(secret.metadata.labels).not.toHaveProperty(LABELS.role);
    expect(secret.metadata.labels).not.toHaveProperty(LABELS.hashed);
    expect(registrySecret(stackRef({ env: 'staging' }), dockerConfigJson({ ...CREDENTIALS, password: 'rotated-password' })).metadata.name).toBe(
      'dockflow-registry',
    );
  });

  test('the name pod templates reference is the name the backend applies', () => {
    expect(K8S_REGISTRY_SECRET).toBe(REGISTRY_PULL_SECRET_NAME);
  });

  test('is the same object for both roles', () => {
    const config = dockerConfigJson(CREDENTIALS);
    expect(registrySecret(stackRef({ role: 'accessory' }), config)).toEqual(registrySecret(stackRef(), config));
  });

  test('the credentials appear only in data', () => {
    const secret = registrySecret(stackRef(), dockerConfigJson(CREDENTIALS));
    const { data, ...rest } = secret;
    const outside = JSON.stringify(rest);
    for (const value of [CREDENTIALS.password, dockerConfigAuth(CREDENTIALS), CREDENTIALS.username]) expect(outside).not.toContain(value);
    const decoded = Buffer.from(data?.['.dockerconfigjson'] ?? '', 'base64').toString('utf8');
    expect(decoded).toContain(CREDENTIALS.password);
  });

  test('registrySecretRedactions masks the password, the auth and the applied data', () => {
    const config = dockerConfigJson(CREDENTIALS);
    const data = registrySecret(stackRef(), config).data?.['.dockerconfigjson'] ?? '';
    const redactor = new Redactor(registrySecretRedactions(CREDENTIALS));
    const echoed = `error: Secret "dockflow-registry" is invalid: data: ${data}; auth ${dockerConfigAuth(CREDENTIALS)}; password ${CREDENTIALS.password}`;
    const redacted = redactor.redact(echoed);
    expect(redacted).not.toContain(CREDENTIALS.password);
    expect(redacted).not.toContain(dockerConfigAuth(CREDENTIALS));
    expect(redacted).not.toContain(data);
    expect(registrySecretRedactions({ server: 'r.example.com', username: '', password: '' })).not.toContain('');
  });

  test('is valid for the API server (schema, data key, base64)', () => {
    const secret = registrySecret(stackRef(), dockerConfigJson(CREDENTIALS));
    expect(validateObject(secret)).toEqual([]);
    // S20 is the artifact ownership rule; the registry Secret carries part=registry on purpose.
    expect(formatIssues(failures(validateSemantics([secret], { namespace: NS, skipRules: ['S20'] })))).toBe('');
  });
});
