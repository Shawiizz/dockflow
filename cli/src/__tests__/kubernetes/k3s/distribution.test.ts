import { describe, expect, test } from 'bun:test';
import {
  K3S_BINARY_PATH,
  K3S_KUBECTL_COMMAND,
  k3sDistribution,
} from '../../../services/orchestrator/kubernetes/k3s/distribution';
import { K3S_SUDO_COMMANDS } from '../../../services/orchestrator/kubernetes/k3s/sudoers';
import { K3S_PIN } from '../../../services/orchestrator/kubernetes/k3s/versions';

const DIGEST = 'a'.repeat(64);

function thrown(fn: () => unknown): Error & { suggestion?: string } {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`non-Error thrown: ${String(error)}`);
  }
  throw new Error('expected a throw');
}

describe('k3sDistribution (U-DIST-01)', () => {
  test('runs kubectl through the k3s wrapper by absolute path', () => {
    expect(k3sDistribution.kubectlCommand).toBe('/usr/local/bin/k3s kubectl');
    expect(K3S_KUBECTL_COMMAND).toBe(k3sDistribution.kubectlCommand);
    expect(K3S_BINARY_PATH).toBe('/usr/local/bin/k3s');
  });

  test('takes its minimum server version from the k3s pin', () => {
    expect(k3sDistribution.minimumServerVersion).toBe('v1.34.0');
    expect(k3sDistribution.minimumServerVersion).toBe(K3S_PIN.minimumServerVersion);
  });

  test('stores local volumes where local-path creates them', () => {
    expect(k3sDistribution.localVolumeRoot).toBe('/var/lib/rancher/k3s/storage');
  });

  test('traits are exactly the k3s facts of DESIGN-CORE 6.3', () => {
    const { reservedHostPorts: _reserved, ...traits } = k3sDistribution.traits;
    expect(traits).toEqual({
      name: 'k3s',
      defaultStorageClass: 'dockflow-local',
      defaultStorageClassAccessModes: ['ReadWriteOnce', 'ReadWriteOncePod'],
      controlPlaneNodeLabel: { key: 'node-role.kubernetes.io/control-plane', value: 'true' },
      loadBalancerNodePorts: false,
      clusterDnsNameservers: 1,
      helperImage: 'rancher/mirrored-library-busybox:1.37.0',
      imageStoreRoot: '/var/lib/rancher/k3s/agent/containerd',
      headlessServiceNeedsPort: false,
      headlessPlaceholderPort: { port: 9, protocol: 'TCP' },
    });
  });

  test('the default class cannot provision ReadWriteMany', () => {
    expect(k3sDistribution.traits.defaultStorageClassAccessModes).not.toContain('ReadWriteMany');
  });

  test('reserves exactly the ports k3s binds, 22/TCP for SSH included', () => {
    expect(
      k3sDistribution.traits.reservedHostPorts.map((r) => `${r.port}/${r.protocol}`),
    ).toEqual([
      '22/TCP',
      '6443/TCP',
      '10250/TCP',
      '2379/TCP',
      '2380/TCP',
      '8472/UDP',
      '51820/UDP',
      '51821/UDP',
      '5001/TCP',
    ]);
    expect(k3sDistribution.traits.reservedHostPorts[0]).toEqual({
      port: 22,
      protocol: 'TCP',
      reason: 'SSH',
    });
  });

  test('every reservation has a reason and appears once', () => {
    const reserved = k3sDistribution.traits.reservedHostPorts;
    for (const r of reserved) expect(r.reason.trim().length).toBeGreaterThan(0);
    const keys = reserved.map((r) => `${r.port}/${r.protocol}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('the servers.yml SSH ports, the nginx plugin ports and Traefik 80/443 are not traits (PD-2)', () => {
    const reserved = k3sDistribution.traits.reservedHostPorts;
    const ports = reserved.map((r) => r.port);
    // 80/443 come from traefikOnCluster or the nginx plugin, 32230 is an e2e servers.yml SSH port
    for (const port of [80, 443, 32230, 32233]) expect(ports).not.toContain(port);
    expect(reserved.some((r) => r.reason.includes('Traefik') || r.reason.includes('nginx'))).toBe(false);
  });

  test('image commands are the sudoers command set, without the sudo prefix', () => {
    expect(k3sDistribution.importImagesCommand()).toBe(
      '/usr/local/bin/k3s ctr -n k8s.io images import --label io.cri-containerd.pinned=pinned -',
    );
    expect(k3sDistribution.listImagesCommands()).toEqual({
      byConfigDigest: '/usr/local/bin/k3s crictl images -o json',
      byTargetDigest: '/usr/local/bin/k3s ctr -n k8s.io images ls',
    });
    expect(k3sDistribution.pruneImagesCommand()).toBe('/usr/local/bin/k3s crictl rmi --prune');
    const lists = k3sDistribution.listImagesCommands();
    for (const command of [
      k3sDistribution.importImagesCommand(),
      lists.byConfigDigest,
      lists.byTargetDigest,
      k3sDistribution.pruneImagesCommand(),
    ]) {
      expect(K3S_SUDO_COMMANDS).toContain(command);
    }
    expect(K3S_SUDO_COMMANDS).toContain('/usr/local/bin/k3s ctr -n k8s.io images rm *');
  });

  test('removeImagesCommand quotes each imported reference as one word', () => {
    expect(
      k3sDistribution.removeImagesCommand([
        'dockflow.invalid/shop-web:1.4.2',
        'dockflow.invalid/registry.example.com:5000/team/api_v2:1.0.0-rc.1',
        `dockflow.invalid/shop-api-production@sha256:${DIGEST}`,
      ]),
    ).toBe(
      "/usr/local/bin/k3s ctr -n k8s.io images rm 'dockflow.invalid/shop-web:1.4.2' " +
        "'dockflow.invalid/registry.example.com:5000/team/api_v2:1.0.0-rc.1' " +
        `'dockflow.invalid/shop-api-production@sha256:${DIGEST}'`,
    );
  });

  test('removeImagesCommand refuses references outside dockflow.invalid/', () => {
    const refused = [
      'shop-web:1.4.2',
      'docker.io/library/busybox:1.37',
      'rancher/mirrored-library-busybox:1.37.0',
      'dockflow.invalid.example.com/shop:1',
      'registry.example.com/dockflow.invalid/shop:1',
      'dockflow.invalid/',
      'dockflow.invalid//shop:1',
      'dockflow.invalid/-shop:1',
      "dockflow.invalid/shop:1'; rm -rf /",
      'dockflow.invalid/shop:1 docker.io/library/busybox:1.37',
      'dockflow.invalid/shop:1\n',
      'dockflow.invalid/$(id)',
      ' dockflow.invalid/shop:1',
      'DOCKFLOW.INVALID/shop:1',
    ];
    for (const ref of refused) {
      const error = thrown(() => k3sDistribution.removeImagesCommand([ref]));
      expect(error.name).toBe('DeployError');
      expect(error.message).toBe(
        `Image ${JSON.stringify(ref)} is not an image Dockflow imported (dockflow.invalid/), so Dockflow does not remove it`,
      );
    }
  });

  test('removeImagesCommand refuses the whole call when one reference is foreign', () => {
    const error = thrown(() =>
      k3sDistribution.removeImagesCommand(['dockflow.invalid/shop-web:1.4.2', 'redis:8-alpine']),
    );
    expect(error.name).toBe('DeployError');
    expect(error.message).toContain('"redis:8-alpine"');
  });

  test('removeImagesCommand refuses an empty reference list', () => {
    const error = thrown(() => k3sDistribution.removeImagesCommand([]));
    expect(error.name).toBe('DeployError');
    expect(error.message).toBe('Image removal was called without any image reference');
  });
});
