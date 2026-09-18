import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { M } from '../../../services/orchestrator/messages';

const SOURCE = readFileSync(join(import.meta.dir, '../../../services/orchestrator/messages.ts'), 'utf-8');

type Render = (...args: (string | number)[]) => string;

describe('messages.ts', () => {
  it('imports nothing, so the MCP package can compile a verbatim copy (U-ARCH-15)', () => {
    expect(SOURCE).not.toMatch(/^\s*import\b/m);
    expect(SOURCE).not.toMatch(/\bimport\s*\(/);
    expect(SOURCE).not.toMatch(/\brequire\s*\(/);
    expect(SOURCE).not.toMatch(/^\s*export\b[^\n]*\bfrom\s*['"]/m);
  });

  it('renders the k3s topology rules of DESIGN-CORE 7.2 exactly', () => {
    expect(M.managerCount('production', 2)).toBe(
      'servers: tag "production" has 2 managers; an embedded-etcd cluster needs an odd number, so declare 1 or 3',
    );
    expect(M.managerCount('staging', 4)).toBe(
      'servers: tag "staging" has 4 managers; an embedded-etcd cluster needs an odd number, so declare 1 or 3',
    );
    expect(M.duplicateNode('web_1', 'web-1', 'web-1')).toBe('servers: "web_1" and "web-1" both become node name "web-1"; rename one');
  });

  it('says "IPv4 or IPv6 address" for private_host', () => {
    expect(M.privateHostIp).toBe('private_host must be an IPv4 or IPv6 address');
    expect(M.privateHostIp).toContain('IPv4 or IPv6 address');
  });

  it('refuses IPv6 cluster addresses on k3s with the setup text', () => {
    expect(M.privateHostIpv6K3s('srv_2')).toBe(
      'servers.srv_2.private_host: IPv6 cluster addresses are not supported by Dockflow k3s setup yet',
    );
    expect(M.privateHostIpv6K3sSuggestion).toBe("Use the node's IPv4 address.");
  });

  it('carries the config.yml rules of DESIGN-CORE 7.1 verbatim', () => {
    expect(M.exactVersion).toBe('must be an exact version such as 1.2.3 (no ranges, no latest)');
    expect(M.helmRequiresK3s).toBe('helm releases require orchestrator: k3s');
    expect(M.helmDuplicateName('web')).toBe('Helm release "web" is declared twice');
    expect(M.helmRepoWithOci).toBe('repo must not be set for an oci:// chart');
    expect(M.helmRepoRequired).toBe('repo is required unless chart starts with oci://');
    expect(M.valuesFileUnrendered('helm/values.yml')).toBe(
      'values file "helm/values.yml" is not rendered: Dockflow only renders files under .dockflow/ and files listed in templates',
    );
    expect(M.remoteBuildK3s).toBe(
      'options.remote_build is not supported with orchestrator: k3s (k3s nodes run containerd only); build locally or push to a registry',
    );
    expect(M.helmRepoPlaintext('http://charts.example.com')).toBe(
      'Chart repository http://charts.example.com is not encrypted; chart contents cannot be authenticated in transit',
    );
    expect(M.chartDigest).toBe("digest must be the 64 hexadecimal characters of the chart archive's sha256");
  });

  it('carries the proxy key rules of design-04 2.3.1 verbatim', () => {
    expect(M.acmeCaServerHttps).toBe('proxy.acme_ca_server must be an https:// URL');
    expect(M.acmeCaNeedsAcme).toBe('proxy.acme_ca_server and proxy.acme_ca_bundle need proxy.acme');
    expect(M.acmeCaBundleNeedsServer).toBe('proxy.acme_ca_bundle only applies to a custom proxy.acme_ca_server');
    expect(M.proxyManageNeedsEnabled).toBe('proxy.manage only applies when proxy.enabled is true');
    expect(M.proxyKeyRequiresK3s('proxy.default_ingress_class')).toBe('proxy.default_ingress_class requires orchestrator: k3s');
  });

  it('follows the message style: one sentence without a trailing period; suggestions end with one', () => {
    for (const [key, value] of Object.entries(M)) {
      const text = typeof value === 'function' ? (value as Render)('x', 'y', 'z') : value;
      expect(text.length).toBeGreaterThan(0);
      if (key.endsWith('Suggestion')) expect(text.endsWith('.')).toBe(true);
      else expect(text.endsWith('.')).toBe(false);
      expect(text).not.toMatch(/\bInvalid\b/);
    }
  });
});
