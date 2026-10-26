# ADR-0017: Plugins: reusable bundles of uploads, templates and hooks

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-26 (plugins kept, as bundles of v2's own mechanisms, at the project owner's request)

## Context

Dockflow 1.x has a plugin system: a manifest (`plugin.yml`) with inputs, uploads and hooks, expanded by about 530 lines with strict templating rules. It ships two built-in plugins: `nginx`, a vhost in `sites-enabled` reloaded after `nginx -t`, and `systemd`, a unit installed and enabled. Projects can also write their own. Real projects use `nginx` everywhere (ValientRP, MohistMC, Dockflow's docs) with their own vhost templates.

The project owner wants the host's nginx to remain a choice next to the built-in proxy, done with hooks and uploads as plugins do.

v2 already has every piece a plugin needs:
- uploads to host paths, atomic, with rollback ([ADR-0021](0021-uploads-and-templates.md));
- Jinja templates ([ADR-0006](0006-compose-as-written.md));
- hooks locally, on hosts and in containers ([ADR-0022](0022-hooks.md)).

## Decision

A plugin is a directory with a `plugin.yml`. It declares:

- **`inputs`**: name, description, `required`, `default`, `type: string | file`;
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
| `nginx` | Uploads a vhost (the default one proxies `domain` to `127.0.0.1:port`, or the project's template) to `/etc/nginx/sites-enabled/`, then runs `sudo nginx -t && sudo systemctl reload nginx` as a fatal `host` hook. A failed test restores the previous vhost through the upload rollback. With the `cloudflare` edge, it also writes the real-IP configuration for Cloudflare's ranges |
| `systemd` | Uploads a unit to `/etc/systemd/system/`, then runs `daemon-reload` and `enable --now` |

`dockflow server init --nginx` installs nginx and the narrow sudo rules these plugins need, as 1.x's `setup --nginx` did.

**Other commands.** `dockflow plugins list` shows built-in and project plugins with their inputs.

**Later.** Third-party plugins fetched from a registry or a git URL are not in v1.

## Consequences

- The host's nginx stays a first-class option. With `cluster init --no-proxy`, it replaces Caddy entirely ([ADR-0011](0011-ingress-caddy.md)).
- Plugins are cheap to maintain: an expansion step over mechanisms that exist anyway.
- One templating language for plugins and projects (Jinja), where 1.x had two sets of rules.
