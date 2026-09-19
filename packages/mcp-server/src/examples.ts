export interface ExampleFile {
  path: string;
  content: string;
}

export interface Example {
  id: string;
  title: string;
  description: string;
  files: ExampleFile[];
  /** Commands and behaviour the files alone do not show */
  notes?: string[];
}

/**
 * Description of the `scenario` input of get_examples. The ids are written out for the client
 * that reads the tool list; examples.test.ts asserts they equal EXAMPLES' ids.
 */
export const SCENARIO_DESCRIPTION =
  'Scenario id: simple, standard, app-with-database, with-proxy, with-registry, multi-server, k3s, k3s-cluster, k3s-helm, k3s-helm-only, with-hooks, with-ci. Omit to list all.';

// Full cluster-mode command: it connects with a root or sudo bootstrap identity, never the deploy key
const K3S_SETUP_COMMAND = 'dockflow setup k3s production --ssh-user root -k ~/.ssh/bootstrap_ed25519';

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
      {
        path: 'accessories.yml',
        content: `services:
  db:
    image: postgres:16
    volumes:
      - db-data:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: myapp
      POSTGRES_USER: myapp
      POSTGRES_PASSWORD: "{{ env.DB_PASSWORD }}"

volumes:
  db-data:`,
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
    title: 'k3s (lightweight Kubernetes), single server',
    description: 'The same compose files deployed to a one-node k3s cluster instead of Docker Swarm. Each environment is one Kubernetes namespace (dockflow-<project>-<env>) holding the app and its accessories, so service names resolve as on Swarm.',
    files: [
      {
        path: 'dockflow.yml',
        content: `project_name: my-app
orchestrator: k3s

servers:
  main:
    host: 203.0.113.10
    # Address the cluster uses for this node (node IP, firewall sources); defaults to host
    private_host: 10.0.0.10
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
      # Published like the Swarm routing mesh: port 8080 answers on every node of the cluster.
      # x-dockflow.publish changes that: hostport (only the node running the pod) or none (cluster only).
      - "8080:3000"
    environment:
      # The redis accessory runs in the same namespace, so its compose name resolves
      REDIS_URL: redis://redis:6379
    deploy:
      replicas: 2`,
      },
      {
        path: 'accessories.yml',
        content: `services:
  redis:
    image: redis:7.4
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redis-data:/data

volumes:
  redis-data:
    x-dockflow:
      # Requested capacity of the PersistentVolumeClaim (default 1Gi)
      size: 5Gi`,
      },
    ],
    notes: [
      `Set the node up once, as root, with a bootstrap key (not the deploy key): \`${K3S_SETUP_COMMAND}\`. It installs the pinned k3s, creates the deploy user and its kubeconfig.`,
      'Deploy as usual with `dockflow deploy production`, and the accessories with `dockflow deploy production --accessories`.',
      'The app and redis run in the namespace dockflow-my-app-production: `redis` resolves inside it exactly as on Swarm.',
      'Named volumes become PersistentVolumeClaims that deploys, `dockflow stop` and `dockflow accessories remove` never delete. List them with `dockflow volumes list production` and delete one only with `dockflow volumes rm production <name>`.',
    ],
  },
  {
    id: 'k3s-cluster',
    title: 'k3s cluster (3 managers + 2 workers)',
    description: 'A highly available k3s cluster: three managers form an embedded-etcd control plane, two workers run workloads, node labels drive placement. Deploy locks and release history live in the cluster, so any manager can take over.',
    files: [
      {
        path: '.dockflow/config.yml',
        content: `project_name: my-app
orchestrator: k3s`,
      },
      {
        path: '.dockflow/servers.yml',
        content: `# Managers are k3s servers, workers are k3s agents.
# An embedded-etcd cluster needs an odd number of managers: 1 or 3, never 2 or 4.
servers:
  cp-1:
    host: 203.0.113.11
    private_host: 10.0.0.11
    role: manager
    tags: [production]
    node_labels:
      zone: eu-west-1a
  cp-2:
    host: 203.0.113.12
    private_host: 10.0.0.12
    role: manager
    tags: [production]
    node_labels:
      zone: eu-west-1b
  cp-3:
    host: 203.0.113.13
    private_host: 10.0.0.13
    role: manager
    tags: [production]
    node_labels:
      zone: eu-west-1c
  worker-1:
    host: 203.0.113.21
    private_host: 10.0.0.21
    role: worker
    tags: [production]
    node_labels:
      zone: eu-west-1a
      disk: ssd
  worker-2:
    host: 203.0.113.22
    private_host: 10.0.0.22
    role: worker
    tags: [production]
    node_labels:
      zone: eu-west-1b
      disk: ssd

defaults:
  user: deploy`,
      },
      {
        path: '.dockflow/docker/docker-compose.yml',
        content: `services:
  api:
    image: my-api
    build:
      context: ../..
      dockerfile: Dockerfile
    ports:
      - "8080:3000"
    deploy:
      replicas: 2
      placement:
        constraints:
          # Matches the node_labels that dockflow setup applies from servers.yml
          - node.labels.zone == eu-west-1a`,
      },
    ],
    notes: [
      `Set the whole cluster up from your machine, with a root or sudo bootstrap key: \`${K3S_SETUP_COMMAND}\`. Preview it first with \`--dry-run\`; re-run it after upgrading Dockflow to upgrade k3s.`,
      'private_host carries the cluster traffic (node IP, join address, firewall sources); keep it on a private network shared by every node.',
      'node_labels become Kubernetes node labels, so `node.labels.<key>` placement constraints work as on Swarm.',
      'Deploys run kubectl on the first reachable manager and fail over to the next one; the deploy lock and the release history are stored in the cluster, so a lost manager loses neither.',
    ],
  },
  {
    id: 'k3s-helm',
    title: 'k3s with Helm releases',
    description: 'Compose services deployed together with Helm charts: an app release from a chart repository, a private OCI chart with registry credentials, and an accessory release.',
    files: [
      {
        path: 'dockflow.yml',
        content: `project_name: my-app
orchestrator: k3s

servers:
  main:
    host: 203.0.113.10
    private_host: 10.0.0.10
    tags: [production]

defaults:
  user: deploy

# Values files are read after rendering: list them here or keep them under .dockflow/
templates:
  - helm/podinfo-values.yml

helm:
  timeout: 5m
  releases:
    - name: podinfo
      chart: podinfo
      repo: https://stefanprodan.github.io/podinfo
      version: 6.15.0
      values_files:
        - helm/podinfo-values.yml
      values:
        replicaCount: 2
    - name: internal-api
      chart: oci://registry.example.com/charts/internal-api
      version: 1.4.2
      auth:
        username: deploy
        password: {{ current.env.registry_password | dump }}
    - name: cache
      chart: oci://registry.example.com/charts/cache
      version: 2.0.1
      role: accessory`,
      },
      {
        path: 'helm/podinfo-values.yml',
        content: `# Rendered with Nunjucks like dockflow.yml, then merged before the inline values
ui:
  message: {{ current.env.podinfo_message | default("Deployed by Dockflow") | dump }}
resources:
  requests:
    cpu: 50m
    memory: 64Mi`,
      },
      {
        path: 'docker-compose.yml',
        content: `services:
  web:
    image: my-app
    build: .
    ports:
      - "8080:3000"
    environment:
      # Releases install into the stack namespace by default, so their services resolve by name
      PODINFO_URL: http://podinfo:9898`,
      },
    ],
    notes: [
      `Set the node up once with \`${K3S_SETUP_COMMAND}\`; it installs the pinned Helm next to k3s.`,
      'App releases (role: app, the default) are upgraded by every `dockflow deploy production`, rolled back with the application, and uninstalled when they leave helm.releases.',
      'Accessory releases (role: accessory) are applied by `dockflow deploy production --accessories` only when their chart or values change, and are never uninstalled implicitly: remove one with `dockflow helm uninstall production cache`.',
      'version pins one exact chart version (no ranges, no latest). Wrap secrets with `| dump`, as the registry password above, so they stay valid YAML.',
      'Inspect releases with `dockflow helm list production`, `dockflow helm status production podinfo` and `dockflow helm history production podinfo`.',
    ],
  },
  {
    id: 'k3s-helm-only',
    title: 'k3s Helm-only project (no compose file)',
    description: 'A project with no docker-compose.yml: Dockflow deploys, locks and rolls back Helm releases only. Nothing is built or transferred.',
    files: [
      {
        path: 'dockflow.yml',
        content: `project_name: my-app
orchestrator: k3s

servers:
  main:
    host: 203.0.113.10
    private_host: 10.0.0.10
    tags: [production]

defaults:
  user: deploy

# No docker-compose.yml: at least one app release makes this a Helm-only project
helm:
  releases:
    - name: podinfo
      chart: podinfo
      repo: https://stefanprodan.github.io/podinfo
      version: 6.15.0
      values:
        replicaCount: 2`,
      },
    ],
    notes: [
      `Set the node up once with \`${K3S_SETUP_COMMAND}\`.`,
      '`dockflow deploy production` installs or upgrades podinfo; `dockflow rollback production` returns to the chart version and values of the previous release.',
      'Day-2 commands that apply: `dockflow status production`, `dockflow logs production podinfo`, and `dockflow helm list|status|history|values|rollback|uninstall`.',
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
  pre-build:
    - name: tests
      script: scripts/test.sh
      fatal: true
  post-deploy:
    - name: notify
      script: scripts/notify.sh`,
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
  if (ex.notes && ex.notes.length > 0) {
    lines.push('### Notes\n');
    for (const note of ex.notes) lines.push(`- ${note}`);
  }
  return lines.join('\n');
}
