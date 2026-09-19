// The `dockflow-registry` pull Secret (DESIGN-CORE 5.5, design-03 12.3): a
// `kubernetes.io/dockerconfigjson` Secret the images backend applies in the stack namespace. It is
// neither immutable nor content-named: pods reference the fixed name, so rotating the credentials
// needs no rollout. The credentials exist only in the object's `data`; nothing here logs or
// returns them in a message, and `registrySecretRedactions` lists what a Redactor must mask.

import type { RegistryCredentials, StackRef } from '../../interfaces';
import { canonicalJson } from '../../../../utils/hash';
import { K8S_REGISTRY_SECRET } from '../constants';
import { registrySecretLabels } from '../labels';
import { namespaceFor } from '../naming';
import type { Secret } from '../resources/core';

export const DOCKER_CONFIG_JSON_TYPE = 'kubernetes.io/dockerconfigjson';
export const DOCKER_CONFIG_JSON_KEY = '.dockerconfigjson';
/** The key kubelet and docker use for Docker Hub credentials. */
export const DOCKER_HUB_CONFIG_SERVER = 'https://index.docker.io/v1/';

const DOCKER_HUB_HOSTS = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);

/**
 * The `auths` key of a registry URL: scheme and path stripped, `host[:port]` kept; every Docker Hub
 * alias maps to the key Docker itself writes.
 */
export function dockerConfigServer(server: string): string {
  const host = server
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split('/')[0];
  return DOCKER_HUB_HOSTS.has(host.toLowerCase()) ? DOCKER_HUB_CONFIG_SERVER : host;
}

/** base64 of `username:password`, the `auth` field kubelet reads */
export function dockerConfigAuth(credentials: RegistryCredentials): string {
  return Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString('base64');
}

/** The dockerconfigjson document, as canonical JSON so the applied bytes never change needlessly. */
export function dockerConfigJson(credentials: RegistryCredentials): string {
  return canonicalJson({
    auths: {
      [dockerConfigServer(credentials.server)]: {
        auth: dockerConfigAuth(credentials),
        password: credentials.password,
        username: credentials.username,
      },
    },
  });
}

/** Values to add to the Redactor before the Secret travels (it also masks their base64 forms). */
export function registrySecretRedactions(credentials: RegistryCredentials): string[] {
  return [credentials.password, dockerConfigAuth(credentials), dockerConfigJson(credentials)].filter((value) => value !== '');
}

/** The Secret carrying `dockerConfig` (the output of `dockerConfigJson`) in the stack namespace of `ref`. */
export function registrySecret(ref: Pick<StackRef, 'project' | 'env'>, dockerConfig: string): Secret {
  const namespace = namespaceFor(ref.project, ref.env);
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: K8S_REGISTRY_SECRET,
      namespace,
      labels: registrySecretLabels({ project: ref.project, namespace }),
    },
    type: DOCKER_CONFIG_JSON_TYPE,
    data: { [DOCKER_CONFIG_JSON_KEY]: Buffer.from(dockerConfig, 'utf8').toString('base64') },
  };
}
