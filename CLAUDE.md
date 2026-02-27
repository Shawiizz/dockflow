# CLAUDE.md

## Project Overview

Dockflow is a deployment framework for Docker applications using Docker Swarm orchestration. It consists of a TypeScript CLI (Bun runtime), an Angular WebUI, Ansible playbooks, and a Next.js documentation site.

## Repository Structure

```
cli-ts/          # TypeScript CLI application (Bun)
cli-ts/ui/       # Angular 21 WebUI (PrimeNG + Tailwind)
ansible/         # Ansible roles and playbooks for deployment
docs/            # Next.js 15 + Nextra documentation site
packages/        # Additional packages (MCP server)
scripts/         # Build & version management scripts
testing/e2e/     # End-to-end tests (run from WSL only)
```

## Common Commands

### CLI (`cli-ts/`)

```bash
bun install                    # Install dependencies
bun run typecheck              # TypeScript validation (npx tsc --noEmit)
bun run dev <command> [args]   # Run CLI locally in dev mode
bun run build                  # Build all platform binaries
bun run ui:build               # Build Angular UI
```

### Docs (`docs/`)

```bash
pnpm install                   # Install dependencies
pnpm dev                       # Next.js dev server
pnpm build                     # Production build + Pagefind indexing
```

### Shell Linting

```bash
./scripts/lint-shell.sh        # ShellCheck on all .sh files
```

### E2E Tests (from WSL)

```bash
cd testing/e2e && bash run-tests.sh
```

## Tech Stack

- **CLI**: TypeScript (strict), Bun runtime, Commander.js, Zod validation, ssh2
- **WebUI**: Angular 21, PrimeNG, Tailwind CSS, xterm.js
- **Deployment**: Ansible (22+ roles), Docker Swarm
- **Docs**: Next.js 15, Nextra (MDX), Pagefind search
- **CI/CD**: GitHub Actions (6 workflows)

## Key Architecture Patterns

- **Console output**: All CLI output goes through `cli-ts/src/utils/output.ts` helpers (`printSuccess`, `printError`, `printWarning`, `printInfo`, `printDebug`, `printDim`, `printBlank`, `printJSON`, `printRaw`). Do not use `console.log` directly in commands.
- **Config validation**: Zod schemas in `cli-ts/src/schemas/config.schema.ts`, mirrored by TypeScript interfaces in `cli-ts/src/utils/config.ts`.
- **SSH connections**: Typed with ssh2 `ConnectConfig` in `cli-ts/src/utils/ssh.ts`.
- **WebSocket handlers**: Typed with Bun's `ServerWebSocket<WSData>` in `cli-ts/src/api/routes/ssh.ts`, includes heartbeat and idle timeout.
- **Ansible defaults**: Centralized in `ansible/group_vars/all.yml` under `dockflow_defaults`. Roles reference these defaults, never hardcode values.
- **CLI config flow to Ansible**: CLI builds an `AnsibleContext` JSON object passed via `-e @/tmp/dockflow_context.json`, making `config.*` values available in playbooks.

## Development Rules

- **Document new features**: Any new feature or configuration option must be documented in the docs site (`docs/app/`). Update the relevant MDX page or create a new one as needed.
- **Typecheck before committing**: Run `bun run typecheck` in `cli-ts/` to ensure zero new TypeScript errors.
- **Use centralized output helpers**: Never add raw `console.log`/`console.error` in CLI commands or API routes. Use the helpers from `utils/output.ts`.
- **Ansible variable centralization**: Default values belong in `ansible/group_vars/all.yml`. Role defaults should reference `dockflow_defaults.*`, not hardcode values.
- **Config schema + interface parity**: When adding a config field, update both the Zod schema (`schemas/config.schema.ts`) and the TypeScript interface (`utils/config.ts`).
