import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  classifyConfigDrift,
  type ConfigDriftInput,
  configHeader,
  type K3sConfigContext,
  MANAGED_CONFIG_KEYS,
  NO_RESTART_CONFIG_KEYS,
  parseK3sConfig,
  renderK3sConfig,
  restartSha256Of,
  SERVER_ONLY_CONFIG_KEYS,
} from '../../../../commands/setup/k3s/config';
import { K3S_AGENT_TOKEN_FILE, K3S_TOKEN_FILE } from '../../../../commands/setup/k3s/constants';
import { setupMessages } from '../../../../commands/setup/k3s/messages';
import type { K3sNodeRole } from '../../../../commands/setup/k3s/plan';

const GOLDEN = join(import.meta.dir, 'golden');
const golden = (name: string): string => readFileSync(join(GOLDEN, name), 'utf8');

function context(overrides: Partial<K3sConfigContext> = {}): K3sConfigContext {
  return {
    env: 'production',
    addressMode: 'private',
    flannelBackend: 'vxlan',
    clusterInit: false,
    network: { nodeIp: null, nodeExternalIp: null },
    joinUrl: null,
    ...overrides,
  };
}

const node = (nodeName: string, role: K3sNodeRole) => ({ nodeName, role });

// design-05 7.1 examples and design-07 U-SETUP-CONFIG-01
const CASES: { golden: string; node: ReturnType<typeof node>; context: K3sConfigContext }[] = [
  {
    golden: 'server-init-single.yaml',
    node: node('srv-1', 'server-init'),
    context: context({ network: { nodeIp: '10.0.0.10', nodeExternalIp: null } }),
  },
  {
    golden: 'server-init-ha.yaml',
    node: node('srv-1', 'server-init'),
    context: context({ clusterInit: true, network: { nodeIp: '10.0.0.10', nodeExternalIp: null } }),
  },
  {
    golden: 'server-join.yaml',
    node: node('srv-2', 'server'),
    context: context({ network: { nodeIp: '10.0.0.11', nodeExternalIp: null }, joinUrl: 'https://10.0.0.10:6443' }),
  },
  {
    golden: 'agent.yaml',
    node: node('worker-1', 'agent'),
    context: context({ network: { nodeIp: '10.0.0.21', nodeExternalIp: null }, joinUrl: 'https://10.0.0.10:6443' }),
  },
  {
    golden: 'server-public.yaml',
    node: node('srv-1', 'server-init'),
    context: context({
      addressMode: 'public',
      flannelBackend: 'wireguard-native',
      clusterInit: true,
      network: { nodeIp: '10.0.0.10', nodeExternalIp: '203.0.113.10' },
    }),
  },
  {
    golden: 'agent-wireguard.yaml',
    node: node('worker-9', 'agent'),
    context: context({
      addressMode: 'public',
      flannelBackend: 'wireguard-native',
      network: { nodeIp: '198.51.100.9', nodeExternalIp: '198.51.100.9' },
      joinUrl: 'https://203.0.113.10:6443',
    }),
  },
  {
    golden: 'server-init-local.yaml',
    node: node('main', 'server-init'),
    context: context({ env: '', network: { nodeIp: '10.0.0.5', nodeExternalIp: null } }),
  },
];

describe('renderK3sConfig goldens (C1-C4, U-SETUP-CONFIG-01)', () => {
  for (const testCase of CASES) {
    it(`${testCase.golden} is byte-exact`, () => {
      const rendered = renderK3sConfig(testCase.node, testCase.context);
      expect(rendered.content).toBe(golden(testCase.golden));
    });
  }

  it('sorts keys by code unit and sorts list values', () => {
    for (const testCase of CASES) {
      const { values } = renderK3sConfig(testCase.node, testCase.context);
      const keys = Object.keys(values);
      expect(keys).toEqual([...keys].sort());
    }
  });

  it('always renders encryption, disabled Traefik and the kubeconfig mode on servers, and never a token value', () => {
    for (const testCase of CASES.filter((c) => c.node.role !== 'agent')) {
      const { values, content } = renderK3sConfig(testCase.node, testCase.context);
      expect(values['secrets-encryption']).toBe(true);
      expect(values['secrets-encryption-provider']).toBe('secretbox');
      expect(values.disable).toEqual(['traefik']);
      expect(values['write-kubeconfig-mode']).toBe('0600');
      expect(values['agent-token-file']).toBe(K3S_AGENT_TOKEN_FILE);
      expect(values['node-name']).toBe(testCase.node.nodeName);
      expect(content).not.toMatch(/^(token|agent-token):/m);
    }
  });

  it('renders token-file with the server URL only on joining servers', () => {
    const init = renderK3sConfig(node('srv-1', 'server-init'), context({ clusterInit: true }));
    expect(init.values['token-file']).toBeUndefined();
    expect(init.values.server).toBeUndefined();
    const joining = renderK3sConfig(node('srv-2', 'server'), context({ joinUrl: 'https://10.0.0.10:6443' }));
    expect(joining.values['token-file']).toBe(K3S_TOKEN_FILE);
    expect(joining.values.server).toBe('https://10.0.0.10:6443');
  });

  it('omits node-ip when the plan has none and node-external-ip in private mode', () => {
    const { values } = renderK3sConfig(
      node('worker-1', 'agent'),
      context({ network: { nodeIp: null, nodeExternalIp: '198.51.100.9' }, joinUrl: 'https://10.0.0.10:6443' }),
    );
    expect(values['node-ip']).toBeUndefined();
    expect(values['node-external-ip']).toBeUndefined();
  });

  it('quotes values k3s would read as another type under YAML 1.1', () => {
    const rendered = renderK3sConfig(node('on', 'agent'), context({ joinUrl: 'https://10.0.0.10:6443' }));
    expect(rendered.content).toContain('node-name: "on"');
    expect(parseK3sConfig(rendered.content)?.['node-name']).toBe('on');
  });

  it('parses back to its own values and restart checksum', () => {
    for (const testCase of CASES) {
      const rendered = renderK3sConfig(testCase.node, testCase.context);
      const parsed = parseK3sConfig(rendered.content);
      expect(parsed).toEqual(rendered.values);
      expect(restartSha256Of(parsed ?? {})).toBe(rendered.restartSha256);
    }
    expect(parseK3sConfig('- a list')).toBeNull();
    expect(parseK3sConfig('a: [')).toBeNull();
  });

  it('names the command in the header', () => {
    expect(configHeader('production')).toBe('# Managed by Dockflow (dockflow setup k3s production). Changes are overwritten.');
    expect(configHeader('')).toBe('# Managed by Dockflow (dockflow setup --orchestrator k3s). Changes are overwritten.');
  });
});

describe('agent files never contain server-only keys (C5)', () => {
  it('holds for every agent shape', () => {
    let checked = 0;
    for (const addressMode of ['private', 'public'] as const) {
      for (const flannelBackend of ['vxlan', 'wireguard-native'] as const) {
        for (const clusterInit of [false, true]) {
          for (const nodeIp of [null, '10.0.0.21']) {
            for (const nodeExternalIp of [null, '198.51.100.9']) {
              for (const joinUrl of [null, 'https://10.0.0.10:6443']) {
                const rendered = renderK3sConfig(
                  node('worker-1', 'agent'),
                  context({ addressMode, flannelBackend, clusterInit, network: { nodeIp, nodeExternalIp }, joinUrl }),
                );
                for (const key of SERVER_ONLY_CONFIG_KEYS) expect(Object.keys(rendered.values)).not.toContain(key);
                expect(rendered.values['token-file']).toBe(K3S_TOKEN_FILE);
                checked += 1;
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(64);
  });

  it('lists every rendered key among the managed keys', () => {
    for (const testCase of CASES) {
      for (const key of Object.keys(renderK3sConfig(testCase.node, testCase.context).values)) expect(MANAGED_CONFIG_KEYS).toContain(key);
    }
    expect(MANAGED_CONFIG_KEYS).toContain('token');
    expect(MANAGED_CONFIG_KEYS).toContain('agent-token');
  });
});

describe('restart-class keys (C7)', () => {
  it('restartSha256 ignores server, token-file and agent-token-file', () => {
    const a = renderK3sConfig(node('srv-2', 'server'), context({ network: { nodeIp: '10.0.0.11', nodeExternalIp: null }, joinUrl: 'https://10.0.0.10:6443' }));
    const b = renderK3sConfig(node('srv-2', 'server'), context({ network: { nodeIp: '10.0.0.11', nodeExternalIp: null }, joinUrl: 'https://10.0.0.12:6443' }));
    expect(a.sha256).not.toBe(b.sha256);
    expect(a.restartSha256).toBe(b.restartSha256);
    for (const key of NO_RESTART_CONFIG_KEYS) expect(Object.keys(a.restartKeys)).not.toContain(key);
    expect(restartSha256Of({ ...a.values, server: 'https://elsewhere:6443', 'token-file': '/x', 'agent-token-file': '/y' })).toBe(a.restartSha256);
  });

  it('restartSha256 changes with a restart-class key', () => {
    const a = renderK3sConfig(node('worker-1', 'agent'), context({ network: { nodeIp: '10.0.0.21', nodeExternalIp: null }, joinUrl: 'https://10.0.0.10:6443' }));
    const b = renderK3sConfig(node('worker-1', 'agent'), context({ network: { nodeIp: '10.0.0.22', nodeExternalIp: null }, joinUrl: 'https://10.0.0.10:6443' }));
    expect(a.restartSha256).not.toBe(b.restartSha256);
  });
});

describe('classifyConfigDrift (C6, design-05 7.3)', () => {
  const serverValues = renderK3sConfig(
    node('srv-2', 'server'),
    context({ network: { nodeIp: '10.0.0.11', nodeExternalIp: null }, joinUrl: 'https://10.0.0.10:6443' }),
  ).values;
  const agentValues = renderK3sConfig(
    node('worker-1', 'agent'),
    context({ network: { nodeIp: '10.0.0.21', nodeExternalIp: null }, joinUrl: 'https://10.0.0.10:6443' }),
  ).values;

  function drift(overrides: Partial<ConfigDriftInput>): ReturnType<typeof classifyConfigDrift> {
    return classifyConfigDrift({
      key: 'srv-2',
      env: 'production',
      etcdMember: false,
      sqliteInit: false,
      existing: serverValues,
      rendered: serverValues,
      backendReason: 'worker-9 has no private_host',
      ...overrides,
    });
  }

  it('reports nothing for an identical file', () => {
    expect(drift({})).toEqual({ refusals: [], restart: [], rewrite: [], convertToEtcd: false });
  });

  it('node-name: refused', () => {
    const result = drift({ existing: { ...serverValues, 'node-name': 'old-name' } });
    expect(result.refusals).toEqual([setupMessages.nodeRenamed('srv-2', 'old-name', 'srv-2')]);
  });

  it('node-ip: refused on an etcd member, restart on an agent or a SQLite server', () => {
    const existing = { ...serverValues, 'node-ip': '10.0.0.99' };
    expect(drift({ existing, etcdMember: true }).refusals).toEqual([setupMessages.etcdNodeIpChange('srv-2', '10.0.0.99', '10.0.0.11')]);
    expect(drift({ existing, etcdMember: false })).toEqual({ refusals: [], restart: ['node-ip'], rewrite: [], convertToEtcd: false });
    const agent = drift({ key: 'worker-1', existing: { ...agentValues, 'node-ip': '10.0.0.99' }, rendered: agentValues });
    expect(agent).toEqual({ refusals: [], restart: ['node-ip'], rewrite: [], convertToEtcd: false });
  });

  it('node-external-ip: restart', () => {
    const result = drift({ key: 'worker-1', existing: agentValues, rendered: { ...agentValues, 'node-external-ip': '198.51.100.21' } });
    expect(result).toEqual({ refusals: [], restart: ['node-external-ip'], rewrite: [], convertToEtcd: false });
  });

  it('flannel-backend and flannel-external-ip: one refusal naming both backends and the reason', () => {
    const rendered = { ...serverValues, 'flannel-backend': 'wireguard-native', 'flannel-external-ip': true };
    const result = drift({ rendered });
    expect(result.refusals).toEqual([
      setupMessages.flannelChange('production', 'vxlan', 'wireguard-native with external IPs', 'worker-9 has no private_host'),
    ]);
    expect(result.refusals[0].message).toBe(
      'The flannel backend of production is vxlan; Dockflow would now use wireguard-native with external IPs (worker-9 has no private_host)',
    );
    const externalOnly = drift({ rendered: { ...serverValues, 'flannel-external-ip': true } });
    expect(externalOnly.refusals).toHaveLength(1);
    // the caller already refused the pod network change for the whole cluster
    expect(drift({ rendered, ignore: ['flannel-backend', 'flannel-external-ip'] }).refusals).toEqual([]);
  });

  it('secrets-encryption: refused', () => {
    const result = drift({ existing: { ...serverValues, 'secrets-encryption': false } });
    expect(result.refusals).toEqual([setupMessages.encryptionChange('srv-2', 'disabled', 'enabled, secretbox')]);
  });

  it('secrets-encryption-provider aescbc -> secretbox: refused with the migration procedure', () => {
    const existing: Record<string, unknown> = { ...serverValues };
    delete existing['secrets-encryption-provider'];
    const result = drift({ existing });
    expect(result.refusals).toEqual([setupMessages.encryptionProviderMigration('srv-2', 'enabled, aescbc', 'enabled, secretbox')]);
    expect(result.refusals[0].suggestion).toContain('k3s secrets-encrypt rotate-keys');
  });

  it('disable: refused', () => {
    const result = drift({ existing: { ...serverValues, disable: ['servicelb', 'traefik'] } });
    expect(result.refusals).toEqual([setupMessages.disabledComponents('srv-2', ['servicelb', 'traefik'])]);
    expect(result.refusals[0].message).toBe('srv-2 disables servicelb, traefik; Dockflow requires exactly [traefik]');
  });

  it('disable in another order is not a change', () => {
    const values = { ...serverValues, disable: ['traefik'] };
    expect(drift({ existing: values, rendered: values }).refusals).toEqual([]);
  });

  it('cluster-init false -> true on the SQLite bootstrap server: conversion', () => {
    const rendered = { ...serverValues, 'cluster-init': true };
    expect(drift({ rendered, sqliteInit: true })).toEqual({ refusals: [], restart: ['cluster-init'], rewrite: [], convertToEtcd: true });
  });

  it('cluster-init on another node: ignored (sticky)', () => {
    expect(drift({ existing: { ...serverValues, 'cluster-init': true } })).toEqual({ refusals: [], restart: [], rewrite: [], convertToEtcd: false });
    expect(drift({ rendered: { ...serverValues, 'cluster-init': true } })).toEqual({ refusals: [], restart: [], rewrite: [], convertToEtcd: false });
  });

  it('write-kubeconfig-mode: restart', () => {
    expect(drift({ existing: { ...serverValues, 'write-kubeconfig-mode': '0644' } }).restart).toEqual(['write-kubeconfig-mode']);
  });

  it('server, token-file, agent-token-file: rewrite without restart', () => {
    const existing = { ...serverValues, server: 'https://10.0.0.12:6443', 'token-file': '/old/token', 'agent-token-file': '/old/agent' };
    expect(drift({ existing })).toEqual({ refusals: [], restart: [], rewrite: ['agent-token-file', 'server', 'token-file'], convertToEtcd: false });
  });

  it('an unknown key in the existing drop-in is removed with a restart', () => {
    expect(drift({ existing: { ...serverValues, 'kubelet-arg': ['max-pods=200'] } })).toEqual({
      refusals: [],
      restart: ['kubelet-arg'],
      rewrite: [],
      convertToEtcd: false,
    });
  });
});
