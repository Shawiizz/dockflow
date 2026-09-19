# Golden fixtures

Each subdirectory renders one or two Compose files (`docker-compose.yml` for role `app`,
`accessories.yml` for role `accessory`) through the real Kubernetes normalizer and translator
(`renderStackArtifact`) and compares the result byte for byte against a committed expectation. See
`cli/src/__tests__/kubernetes/support/golden.ts` for the harness and `cli/src/__tests__/kubernetes/golden.test.ts`
for the assertions.

## Layout

```
<case>/
  input.json               required: description plus the render inputs (see below)
  docker-compose.yml       optional (absent for an accessory-only case)
  accessories.yml          optional
  files/                   optional: env_file, label_file, secret/config file sources
  helm/                    optional: values files a Helm release's values_files points at,
                            mirroring .dockflow/helm/ (the input declares them as
                            ".dockflow/helm/<name>.yml")
  expected-app.yaml        present when the app role renders successfully
  expected-accessory.yaml  present when the accessory role renders successfully
  expected-helm.json       present when input.json declares any Helm release
  expected-diagnostics.json  always: {"app": Diagnostic[], "accessory": Diagnostic[]}
```

A case whose render must fail for a role sets `expectRenderError.<role>: true` instead of shipping
an `expected-<role>.yaml`. A case whose *compose file itself* is invalid YAML (a duplicate key, more
than one document, an `!reset`/`!override` tag, an alias with no anchor) sets `expectLoadError` to
the exact `ConfigError` message and ships no compose-derived files at all: the file never reaches the
normalizer.

## `input.json`

Validated against a zod schema (`GoldenInputSchema` in `support/golden.ts`); unknown keys are
refused. See `input.schema.json` for a mirror an editor can use for completion. Every field besides
`description` is optional and defaults the way `deployInput()`/`renderStackArtifact` would in
production:

| Field | Feeds | Default |
|---|---|---|
| `description` | (documentation only) | required |
| `identity` | `project`/`env`/`version` | `shop` / `production` / `1.4.2` |
| `proxy` | `ProxyConfig`, both roles | absent (proxy disabled) |
| `images` | `mode`, `built`, `pullSecretName` | `{mode: 'none', built: [], pullSecretName: null}` |
| `imageDelivery` | `NormalizeInput.imageDelivery` | `'import'` |
| `keepReleases` | `revisionHistoryLimit` | 3 |
| `serverSshPorts` | the default `extraReservedHostPorts` (one `SSH port of server_1` entry per port) | `[22]` |
| `extraReservedHostPorts` | full override of the reservation set | derived from `serverSshPorts` |
| `serverNames` | placement validation, node selectors | `['server_1', 'agent_1']` |
| `traits` | overrides over the k3s distribution traits | none |
| `secretFiles` | paths under `files/` that G-11 asserts never appear in plain text | `[]` |
| `helm.releases` | resolved per role through the real `resolveHelmReleases` | `[]` |
| `traefikOnCluster` | `TranslateOptions.traefikOnCluster` | `proxy.enabled === true` |
| `stabilityVersion` | a second accessory render at this version, compared byte for byte | none |
| `expectRenderError.<role>` | the role's render must throw `ComposeTranslationError` | `false` |
| `expectLoadError` | the compose file itself must fail to load with this exact message | none |

## Updating an expectation

`bun run scripts/update-golden.ts [case ...]` is the **only** way to write or change an
`expected-*` file (with no arguments, every case is rewritten). It refuses to run when `CI` is set,
renders each case through the same path `golden.test.ts` uses, and finishes by running the golden
suite against what it just wrote. Review every changed expectation against design-02 §12 (the
catalogue that owns the case list and each case's asserted content) before committing it — the
script cannot tell a genuine behaviour change from a regression.

`git status --porcelain -- src/__tests__/kubernetes/golden` after the script tells you what changed.
A clean tree before and after one run means the harness is deterministic.
