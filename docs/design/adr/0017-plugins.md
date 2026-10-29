# ADR-0017: Plugins: reusable bundles of uploads, templates and hooks

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-26 (plugins kept, as bundles of v2's own mechanisms, at the project owner's request)

## Context

Dockflow 1.x has a plugin system: a manifest (`plugin.yml`) with inputs, uploads and hooks, expanded by about 530 lines with strict templating rules. It ships two built-in plugins: `nginx`, a vhost in `sites-enabled` reloaded after `nginx -t`, and `systemd`, a unit installed and enabled. Projects can also write their own. Every real project studied, Dockflow's docs included, uses `nginx` with its own vhost templates.

The project owner wants the host's nginx to remain a choice next to the built-in proxy, done with hooks and uploads as plugins do.

v2 already has every piece a plugin needs:
- uploads to host paths, atomic, with rollback ([ADR-0021](0021-uploads-and-templates.md));
- Jinja templates ([ADR-0006](0006-compose-as-written.md));
- hooks locally, on hosts and in containers ([ADR-0022](0022-hooks.md)).

## Decision

A plugin is a directory with a `plugin.yml`. It declares:

- **`inputs`**: name, description, `required` (or `required_unless` another input is given), `default`, `type: string | file`, and `pattern`, a regular expression a value must match whole (each item of a list, a file's name). The built-in plugins give one to every input that reaches a command run with sudo or nginx's configuration: a unit name matches `[A-Za-z0-9@._-]+`, a domain is a host name or a `*.` wildcard. Templates have a `shquote` filter that makes a value one shell word;
- **`uploads`**: as in `dockflow.yml`, with `src` relative to the plugin;
- **`hooks`**: as in `dockflow.yml`;
- **`templates`**: rendered with the inputs in their context.

A project uses a plugin under `plugins:` in `dockflow.yml`:

```yaml
# dockflow.yml
plugins:
  - use: nginx                      # built-in
    with:
      domain: api.example.com
      port: 3013
      template: deploy/nginx/api.conf   # optional: the project's own vhost
  - use: ./deploy/plugins/rclone    # the project's own plugin
    id: archives
    with: { remote: "ovhs3:archives", mount: /mnt/archives }
```

**Expansion.** At load time, each use is expanded into ordinary uploads, templates and hooks. The plan shows them with the plugin they come from. A plugin adds no mechanism of its own: everything it does follows the rules of uploads and hooks, rollback included.

**Built-in plugins**, shipped in the binary:

| Plugin | What it does |
|---|---|
| `nginx` | Uploads a vhost to `/etc/nginx/sites-enabled/`: by default one that proxies `domain` to the switch's address (or, with the `none` edge, to `127.0.0.1:port`), or the project's own template. When the vhost changed, it runs `sudo nginx -t && sudo systemctl reload nginx` as a fatal `host` hook; a failed test restores the previous vhost through the upload rollback. Its `cloudflare: true` input adds the real-IP configuration for Cloudflare's ranges |
| `systemd` | Uploads a unit to `/etc/systemd/system/`, then runs `daemon-reload` and `enable --now` |

`dockflow server init --nginx` installs nginx and the narrow sudo rules these plugins need, as 1.x's `setup --nginx` did.

**Other commands.** `dockflow plugins list` shows built-in and project plugins with their inputs.

**Later.** Third-party plugins fetched from a registry or a git URL are not in v1.

## Implementation (M3)

- **Inputs.** Besides `string` and `file`, inputs can be `boolean` and `list`, so a template can write `{% if cloudflare %}` and loop over domains. A `file` input's file is copied into the plugin, at `inputs/<input>/<name>`, and its value is that path.
- **Rendering.** Every string of `templates`, `uploads` and `hooks` in `plugin.yml` is rendered with Jinja (the inputs, `id`, the built-in variables and `vars`, never the secrets); template files also see the secrets, as the project's do. The plugin's files are held in memory and written to the run's temporary workspace when an upload reads them.
- **When the vhost changed.** `if_changed`, a key of `plugin.yml`'s `after_deploy` hooks only, names one of the plugin's uploads: the hook runs only when the deploy's plan changed it. `nginx` and `systemd` use it, so a deploy that changes nothing reloads nothing.
- **Order.** The plugins' uploads and hooks come before the project's own. Hooks have no `script` in a plugin: its files are not the project's.
- **`nginx`.** Inputs `domain` (a list), `upstream` (the switch, `127.0.0.1:8080`), `port` (the `none` edge), `tls` and `certificate_dir` (certbot's), `cloudflare`, `ipv6`, `max_body_size`, `dir`, `name` and `template`. Cloudflare's ranges are written into the vhost's `server` block from the list the binary carries: at the `http` level, a second app behind Cloudflare would repeat `real_ip_header`, which nginx refuses. The rendered vhosts are checked with a real `nginx -t`, together, in the e2e suite.
- **`systemd`.** Inputs `unit` (a file) and `name`; when the unit changed: `daemon-reload`, `enable` and `restart`, a non-fatal hook, since a rollback would put the previous unit back without restarting it.
- **Not yet.** `server init --nginx` arrives with the rest of provisioning; until then the sudo rules are written by hand.

## Consequences

- The host's nginx stays a first-class option, in front of the switch with the `external` edge ([ADR-0011](0011-switch-and-edge.md)). The switch handles zero-downtime transitions, so the `nginx` plugin writes a static vhost, reloaded only when domains change.
- Plugins are cheap to maintain: an expansion step over mechanisms that exist anyway.
- One templating language for plugins and projects (Jinja), where 1.x had two sets of rules.
