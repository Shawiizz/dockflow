/**
 * Validation messages shared by the config schemas, `dockflow setup`, `dockflow validate` and the
 * MCP validator, so a mistake reads the same in every tool. The MCP package cannot depend on
 * `cli/`: cli/scripts/sync-mcp-messages.ts copies this file verbatim, which is why it imports
 * nothing. Placeholders are function parameters.
 */

export const M = {
  // config.yml: helm.releases[] and helm.timeout constraints
  helmName: 'name must be lowercase letters, digits and -, starting and ending with a letter or digit',
  helmNameTooLong: 'name must be at most 53 characters, the Helm release name limit',
  helmChart: 'chart must be a chart name, or an oci:// reference',
  helmRepoUrl: 'repo must be an https:// or http:// URL',
  exactVersion: 'must be an exact version such as 1.2.3 (no ranges, no latest)',
  chartDigest: "digest must be the 64 hexadecimal characters of the chart archive's sha256",
  namespaceLabel: 'namespace must be lowercase letters, digits and -, at most 63 characters, starting and ending with a letter or digit',
  duration: 'timeout must be a duration such as 90s, 5m or 1h30m',
  valuesFilePath: 'values_files entries must be non-empty paths',
  helmAuthField: 'auth.username and auth.password must not be empty',

  // config.yml: cross-field rules
  helmRequiresK3s: 'helm releases require orchestrator: k3s',
  helmDuplicateName: (name: string): string => `Helm release "${name}" is declared twice`,
  helmRepoWithOci: 'repo must not be set for an oci:// chart',
  helmRepoRequired: 'repo is required unless chart starts with oci://',
  valuesFileUnrendered: (path: string): string =>
    `values file "${path}" is not rendered: Dockflow only renders files under .dockflow/ and files listed in templates`,
  remoteBuildK3s:
    'options.remote_build is not supported with orchestrator: k3s (k3s nodes run containerd only); build locally or push to a registry',

  // Helm repositories (warning and refusal, not zod rules)
  helmRepoPlaintext: (url: string): string =>
    `Chart repository ${url} is not encrypted; chart contents cannot be authenticated in transit`,
  helmOciPlainHttp: (ref: string): string =>
    `chart "${ref}" needs an OCI registry over plain HTTP, which Dockflow does not support; serve the registry over HTTPS`,

  // config.yml: proxy keys that exist on Kubernetes only
  proxyKeyRequiresK3s: (key: string): string => `${key} requires orchestrator: k3s`,
  proxyManageNeedsEnabled: 'proxy.manage only applies when proxy.enabled is true',
  acmeCaServerHttps: 'proxy.acme_ca_server must be an https:// URL',
  acmeCaNeedsAcme: 'proxy.acme_ca_server and proxy.acme_ca_bundle need proxy.acme',
  acmeCaBundleNeedsServer: 'proxy.acme_ca_bundle only applies to a custom proxy.acme_ca_server',
  acmeCaBundlePath: 'proxy.acme_ca_bundle must be the project path of a PEM file',
  acmeCaBundleUnrendered: (path: string): string =>
    `proxy.acme_ca_bundle "${path}" is not rendered: Dockflow only renders files under .dockflow/ and files listed in templates`,

  // servers.yml
  privateHostIp: 'private_host must be an IPv4 or IPv6 address',
  labelKey:
    'node label keys must be an optional DNS subdomain and /, then at most 63 letters, digits, -, _ or . starting and ending with a letter or digit',
  labelKeyTooLong: 'node label keys must be at most 253 characters',
  labelKeyReserved: 'node label keys under kubernetes.io/, k8s.io/ and dockflow.shawiizz.dev/ are reserved',
  labelValue: 'node label values must be empty, or letters, digits, -, _ and . starting and ending with a letter or digit',
  labelValueTooLong: 'node label values must be at most 63 characters',

  // servers.yml topology rules enforced for orchestrator: k3s by setup, validate <env> and the MCP validator
  managerCount: (tag: string, managers: number): string =>
    `servers: tag "${tag}" has ${managers} managers; an embedded-etcd cluster needs an odd number, so declare 1 or 3`,
  duplicateNode: (first: string, second: string, node: string): string =>
    `servers: "${first}" and "${second}" both become node name "${node}"; rename one`,
  privateHostIpv6K3s: (server: string): string =>
    `servers.${server}.private_host: IPv6 cluster addresses are not supported by Dockflow k3s setup yet`,
  privateHostIpv6K3sSuggestion: "Use the node's IPv4 address.",
} as const;
