# Dockflow UI

Angular-based WebUI for Dockflow.

## Development

```bash
# Install dependencies
pnpm install

# Start development server (runs on port 4201)
pnpm start

# Build for production
pnpm build
```

## Architecture

- **Angular 19+** with standalone components
- **PrimeNG** for UI components (Aura theme)
- **TailwindCSS v4** for utility-first styling
- **Dark/Light mode** support

## Folder Structure

```
src/app/
├── core/           # Services, guards, interceptors
├── features/       # Feature modules (dashboard, logs, etc.)
└── shared/         # Shared components, pipes, directives
```
