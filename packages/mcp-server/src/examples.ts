export interface ExampleFile {
  path: string;
  content: string;
}

export interface Example {
  id: string;
  title: string;
  description: string;
  files: ExampleFile[];
}

export const EXAMPLES: Example[] = [
  {
    id: 'simple',
    title: 'Simple app (flat layout)',
    description: 'Single service, single server. Uses dockflow.yml at the project root — no .dockflow/ directory needed. Ideal for getting started quickly. SSH credentials go in .env.dockflow (never committed) or as CI/CD secrets.',
    files: [
      {
        path: 'dockflow.yml',
        content: `project_name: my-app

servers:
  main:
    host: 1.2.3.4
    tags: [production]

defaults:
  user: deploy
  port: 22`,
      },
      {
        path: '.env.dockflow',
        content: `# SSH credentials — add to .gitignore, never commit this file
# Format: base64(user@host:port|privateKey)  or  base64(user@host:port||password)
# Generate with: dockflow encode
PRODUCTION_MAIN_CONNECTION=base64encodedstring`,
      },
      {
        path: 'docker-compose.yml',
        content: `services:
  app:
    image: my-app
    build: .
    ports:
      - "3000:3000"
    deploy:
      replicas: 1
      restart_policy:
        condition: on-failure`,
      },
    ],
  },
  {
    id: 'standard',
    title: 'Standard layout (.dockflow/ directory)',
    description: 'The default layout with separate config.yml, servers.yml, and docker-compose.yml under .dockflow/. Suited for larger projects with multiple environments or shared server configs. SSH credentials go in .env.dockflow or as CI/CD secrets.',
    files: [
      {
        path: '.dockflow/config.yml',
        content: `project_name: my-app

health_checks:
  enabled: true
  endpoints:
    - url: https://my-app.example.com
      retries: 5

stack_management:
  keep_releases: 3`,
      },
      {
        path: '.dockflow/servers.yml',
        content: `servers:
  main:
    host: 1.2.3.4
    tags: [production]

defaults:
  user: deploy
  port: 22`,
      },
      {
        path: '.env.dockflow',
        content: `# SSH credentials — add to .gitignore, never commit this file
# Format: base64(user@host:port|privateKey)  or  base64(user@host:port||password)
# Generate with: dockflow encode
PRODUCTION_MAIN_CONNECTION=base64encodedstring`,
      },
      {
        path: '.dockflow/docker/docker-compose.yml',
        content: `services:
  app:
    image: my-app
    build:
      context: ../..
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    deploy:
      replicas: 1
      restart_policy:
        condition: on-failure`,
      },
    ],
  },
  {
    id: 'app-with-database',
    title: 'App with database (accessories)',
    description: 'Main app + PostgreSQL accessory managed as a separate Swarm stack. Includes backup configuration.',
    files: [
      {
        path: 'dockflow.yml',
        content: `project_name: my-app

servers:
  main:
    host: 1.2.3.4
    tags: [production]

defaults:
  user: deploy

accessories:
  db:
    image: postgres:16
    volumes:
      - db-data:/var/lib/postgresql/data
    env:
      POSTGRES_DB: myapp
      POSTGRES_USER: myapp
      POSTGRES_PASSWORD: "{{ env.DB_PASSWORD }}"

backup:
  accessories:
    db:
      type: postgres`,
      },
      {
        path: 'docker-compose.yml',
        content: `services:
  app:
    image: my-app
    build: .
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: "postgresql://myapp:{{ env.DB_PASSWORD }}@db:5432/myapp"
    deploy:
      replicas: 1
      restart_policy:
        condition: on-failure`,
      },
    ],
  },
  {
    id: 'with-proxy',
    title: 'Automatic HTTPS with Traefik',
    description: 'Traefik reverse proxy with Let\'s Encrypt certificates. Requires dockflow setup to have been run with Traefik enabled.',
    files: [
      {
        path: 'dockflow.yml',
        content: `project_name: my-app

servers:
  main:
    host: 1.2.3.4
    tags: [production]

defaults:
  user: deploy

proxy:
  enabled: true
  email: admin@example.com
  domains:
    production: my-app.example.com`,
      },
      {
        path: 'docker-compose.yml',
        content: `services:
  app:
    image: my-app
    build: .
    deploy:
      replicas: 2
      restart_policy:
        condition: on-failure
      labels:
        - "traefik.enable=true"
        - "traefik.http.routers.my-app-production.rule=Host(\`{{ proxy.domain }}\`)"
        - "traefik.http.services.my-app-production.loadbalancer.server.port=3000"`,
      },
    ],
  },
  {
    id: 'with-registry',
    title: 'Registry push (GHCR)',
    description: 'Build locally, push to GitHub Container Registry, pull on the server. No image transfer over SSH.',
    files: [
      {
        path: 'dockflow.yml',
        content: `project_name: my-app

servers:
  main:
    host: 1.2.3.4
    tags: [production]

defaults:
  user: deploy

registry:
  type: ghcr
  username: myuser
  token: "{{ env.GITHUB_TOKEN }}"
  namespace: myorg`,
      },
      {
        path: 'docker-compose.yml',
        content: `services:
  app:
    image: my-app
    build: .
    ports:
      - "3000:3000"
    deploy:
      replicas: 1`,
      },
    ],
  },
  {
    id: 'multi-server',
    title: 'Multi-node Swarm (manager + workers)',
    description: 'Docker Swarm cluster with one manager and two workers. Services are distributed across nodes.',
    files: [
      {
        path: 'dockflow.yml',
        content: `project_name: my-app

servers:
  manager:
    host: 1.2.3.4
    role: manager
    tags: [production]
  worker-1:
    host: 1.2.3.5
    role: worker
    tags: [production]
  worker-2:
    host: 1.2.3.6
    role: worker
    tags: [production]

defaults:
  user: deploy`,
      },
      {
        path: 'docker-compose.yml',
        content: `services:
  app:
    image: my-app
    build: .
    ports:
      - "3000:3000"
    deploy:
      replicas: 3
      restart_policy:
        condition: on-failure
      update_config:
        parallelism: 1
        delay: 10s`,
      },
    ],
  },
  {
    id: 'k3s',
    title: 'k3s (lightweight Kubernetes)',
    description: 'Deploy to a k3s cluster instead of Docker Swarm. Each stack becomes a Kubernetes namespace.',
    files: [
      {
        path: 'dockflow.yml',
        content: `project_name: my-app
orchestrator: k3s

servers:
  main:
    host: 1.2.3.4
    tags: [production]

defaults:
  user: deploy`,
      },
      {
        path: 'docker-compose.yml',
        content: `services:
  app:
    image: my-app
    build: .
    ports:
      - "3000:3000"
    deploy:
      replicas: 2`,
      },
    ],
  },
  {
    id: 'with-hooks',
    title: 'Lifecycle hooks',
    description: 'Run custom scripts before/after build and deploy — e.g. run tests, send notifications, warm up caches.',
    files: [
      {
        path: 'dockflow.yml',
        content: `project_name: my-app

servers:
  main:
    host: 1.2.3.4
    tags: [production]

defaults:
  user: deploy

hooks:
  enabled: true
  pre-build: scripts/test.sh
  post-deploy: scripts/notify.sh`,
      },
      {
        path: 'scripts/test.sh',
        content: `#!/bin/bash
set -e
echo "Running tests before build..."
npm test`,
      },
      {
        path: 'scripts/notify.sh',
        content: `#!/bin/bash
echo "Deployment complete: $DOCKFLOW_VERSION to $DOCKFLOW_ENV"`,
      },
    ],
  },
  {
    id: 'with-ci',
    title: 'GitHub Actions CI/CD',
    description: 'Full CI/CD pipeline: build on push to main, deploy automatically via dockflow deploy.',
    files: [
      {
        path: 'dockflow.yml',
        content: `project_name: my-app

servers:
  main:
    tags: [production]  # host comes from CI secret: PRODUCTION_MAIN_CONNECTION

defaults:
  user: deploy`,
      },
      {
        path: '.github/workflows/deploy.yml',
        content: `name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Dockflow
        run: npm install -g @dockflow-tools/cli

      - name: Deploy
        run: dockflow deploy production
        env:
          # Format: base64(user@host:port|privateKey)
          PRODUCTION_MAIN_CONNECTION: \${{ secrets.PRODUCTION_MAIN_CONNECTION }}`,
      },
    ],
  },
];

export function listExamples(): string {
  const lines = ['Available examples:\n'];
  for (const ex of EXAMPLES) {
    lines.push(`• **${ex.id}** — ${ex.title}`);
    lines.push(`  ${ex.description}\n`);
  }
  lines.push('Call get_examples with a scenario id to get the full files.');
  return lines.join('\n');
}

export function formatExample(ex: Example): string {
  const lines: string[] = [`## ${ex.title}\n`, ex.description, ''];
  for (const file of ex.files) {
    const ext = file.path.split('.').pop() ?? 'yaml';
    const lang = ext === 'sh' ? 'bash' : ext === 'yml' || ext === 'yaml' ? 'yaml' : 'text';
    lines.push(`### \`${file.path}\`\n\`\`\`${lang}\n${file.content}\n\`\`\`\n`);
  }
  return lines.join('\n');
}
