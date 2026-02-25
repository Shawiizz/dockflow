/**
 * Init command
 * Initialize project structure (native, no Docker needed)
 */

import type { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import inquirer from 'inquirer';
import { getProjectRoot } from '../utils/config';
import { printSuccess, printInfo, printHeader, printWarning } from '../utils/output';
import { withErrorHandler } from '../utils/errors';
import { DOCKFLOW_VERSION } from '../constants';

// GitHub Actions workflow using Dockflow reusable workflows
const getGithubWorkflow = (version: string) => `name: CI/CD

on:
  push:
    branches:
      - '*'
    tags:
      - '*'

# Note: Make sure your .dockflow/config.yml has project_name set
# and add your connection secrets (e.g., PRODUCTION_CONNECTION) to GitHub Secrets

jobs:
  # Build job - runs on every push to branches
  build:
    if: github.ref_type == 'branch'
    uses: Shawiizz/dockflow/.github/workflows/build.yml@${version}
    with:
      free-disk-space: false

  # Deploy on tag push (e.g., v1.0.0 or v1.0.0-staging)
  deploy-tag:
    if: github.ref_type == 'tag'
    uses: Shawiizz/dockflow/.github/workflows/deploy.yml@${version}
    with:
      tag: \${{ github.ref_name }}
      free-disk-space: false
    secrets: inherit

  # Optional: Deploy on branch push (uncomment if needed)
  # deploy-branch:
  #   if: github.ref_type == 'branch'
  #   uses: Shawiizz/dockflow/.github/workflows/deploy.yml@${version}
  #   with:
  #     version: \${{ github.ref_name }}-\${{ github.sha }}
  #     free-disk-space: false
  #   secrets: inherit
`;

// GitLab CI using Dockflow CI image
const GITLAB_CI = `stages:
  - build
  - deploy

variables:
  DOCKFLOW_VERSION: "${DOCKFLOW_VERSION}"

# Build job - runs on every push
build:
  stage: build
  image: docker:latest
  services:
    - docker:dind
  script:
    - echo "Build step (customize as needed)"
  rules:
    - if: $CI_COMMIT_BRANCH

# Deploy on tag push
deploy:
  stage: deploy
  image: ubuntu:22.04
  services:
    - docker:dind
  variables:
    DOCKER_HOST: tcp://docker:2375
    DOCKER_TLS_CERTDIR: ""
  script:
    - |
      # Install Dockflow CLI
      apt-get update && apt-get install -y curl docker.io
      curl -fsSL https://raw.githubusercontent.com/Shawiizz/dockflow/main/install.sh | bash
      
      # Determine environment from tag suffix (e.g., 1.0.0-staging -> staging)
      VERSION="\${CI_COMMIT_TAG#v}"
      ENV="\${CI_COMMIT_TAG##*-}"
      [[ "$CI_COMMIT_TAG" == "$ENV" ]] && ENV="production"
      
      # Deploy using CLI
      dockflow deploy "$ENV" "$VERSION"
  rules:
    - if: $CI_COMMIT_TAG
`;

const CONFIG_YML = `# Dockflow Configuration
# See https://dockflow.shawiizz.dev/configuration for full documentation

project_name: "my-app"

# Registry configuration (optional)
# registry:
#   type: dockerhub  # dockerhub, ghcr, gitlab, custom
#   username: "{{ registry_username }}"
#   password: "{{ registry_password }}"

# Build options
options:
  remote_build: false       # Build on remote server instead of locally
  image_auto_tag: true      # Auto-append -<env>:<version> to image names

# Health checks
health_checks:
  enabled: true
  on_failure: notify       # notify or rollback
  # endpoints:
  #   - url: "https://myapp.example.com/health"
  #     expected_status: 200

# Hooks (optional)
# hooks:
#   pre-build: "./scripts/pre-build.sh"
#   post-build: "./scripts/post-build.sh"
#   pre-deploy: "./scripts/pre-deploy.sh"
#   post-deploy: "./scripts/post-deploy.sh"
`;

// Servers configuration - new unified format for Docker Swarm clusters
const SERVERS_YML = `# Servers Configuration
# Define your Docker Swarm cluster: one manager + optional workers
# See https://dockflow.shawiizz.dev/configuration/servers for full documentation

# ═══════════════════════════════════════════════════════════════════════════════
# SERVERS
# Each environment needs exactly ONE manager (receives deployments).
# Workers are optional - they join the Swarm and receive workloads automatically.
# ═══════════════════════════════════════════════════════════════════════════════
servers:
  # Production manager (required - this is where deployments happen)
  main_server:
    role: manager                    # manager or worker (default: manager)
    # host: "192.168.1.10"           # Can be set via CI secret for security
    tags: [production]               # Environment tag
    env:                             # Server-specific variables
      NODE_ID: "manager"

  # Optional: Add workers for horizontal scaling
  # worker_1:
  #   role: worker
  #   host: "192.168.1.11"
  #   tags: [production]
  #   env:
  #     NODE_ID: "worker-1"
  
  # worker_2:
  #   role: worker
  #   host: "192.168.1.12"
  #   tags: [production]
  #   env:
  #     NODE_ID: "worker-2"

  # Staging environment (single-node example)
  # staging_server:
  #   role: manager
  #   tags: [staging]

# ═══════════════════════════════════════════════════════════════════════════════
# DEFAULTS
# Default SSH settings applied to all servers (can be overridden per server)
# ═══════════════════════════════════════════════════════════════════════════════
defaults:
  user: dockflow
  port: 22

# ═══════════════════════════════════════════════════════════════════════════════
# ENVIRONMENT VARIABLES
# Variables are inherited: all -> [tag] -> server.env -> CI secrets
# ═══════════════════════════════════════════════════════════════════════════════
env:
  # Variables applied to ALL environments
  all:
    APP_NAME: "{{ project_name }}"
    LOG_LEVEL: "info"
    TZ: "UTC"

  # Production-specific variables (override "all")
  production:
    LOG_LEVEL: "warn"
    # DATABASE_URL: "postgres://prod-db:5432/myapp"
    # DOMAIN: "app.example.com"

  # Staging-specific variables
  # staging:
  #   LOG_LEVEL: "debug"
  #   DATABASE_URL: "postgres://staging-db:5432/myapp"
  #   DOMAIN: "staging.example.com"

# ═══════════════════════════════════════════════════════════════════════════════
# CLUSTER SETUP
# Before first deployment, initialize the Swarm cluster:
#   dockflow setup swarm production
# This opens firewall ports and joins workers to the manager.
# ═══════════════════════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════════════════════
# CI SECRETS REFERENCE
# Add these secrets to your CI/CD platform (GitHub Secrets, GitLab CI Variables)
# 
# For each server, one of:
#   PRODUCTION_MAIN_SERVER_CONNECTION  - Full connection string (recommended)
#   PRODUCTION_MAIN_SERVER_SSH_PRIVATE_KEY + PRODUCTION_MAIN_SERVER_HOST
#
# Optional overrides:
#   PRODUCTION_DATABASE_URL           - Override for all production servers
#   PRODUCTION_MAIN_SERVER_DATABASE_URL - Override for specific server
# ═══════════════════════════════════════════════════════════════════════════════
`;

// Accessories template - standard docker-compose format with Swarm config
const ACCESSORIES_YML = `# Accessories - Stateful services (databases, caches, etc.)
# These have a separate lifecycle from the main application
# 
# Deploy with: dockflow deploy <env> --accessories
# Manage with: dockflow accessories list|logs|exec|restart|stop|remove <env>
#
# This file uses standard Docker Compose format with Jinja2 templating support.
# Environment variables can be accessed with {{ variable_name }}

version: "3.8"

services:
  # Example: PostgreSQL database
  # postgres:
  #   image: postgres:16-alpine
  #   ports:
  #     - "5432:5432"
  #   volumes:
  #     - postgres_data:/var/lib/postgresql/data
  #   environment:
  #     POSTGRES_USER: app
  #     POSTGRES_PASSWORD: "{{ db_password }}"
  #     POSTGRES_DB: myapp
  #   healthcheck:
  #     test: ["CMD-SHELL", "pg_isready -U app"]
  #     interval: 10s
  #     timeout: 5s
  #     retries: 5
  #     start_period: 30s
  #   deploy:
  #     replicas: 1
  #     placement:
  #       constraints:
  #         - node.role == manager
  #     restart_policy:
  #       condition: on-failure
  #       delay: 5s
  #       max_attempts: 3
  #     # No update_config: we want controlled updates for DBs

  # Example: Redis cache
  # redis:
  #   image: redis:7-alpine
  #   ports:
  #     - "6379:6379"
  #   volumes:
  #     - redis_data:/data
  #   command: redis-server --appendonly yes
  #   healthcheck:
  #     test: ["CMD", "redis-cli", "ping"]
  #     interval: 10s
  #     timeout: 5s
  #     retries: 5
  #   deploy:
  #     replicas: 1
  #     restart_policy:
  #       condition: on-failure
  #       delay: 5s

# volumes:
#   postgres_data:
#   redis_data:
`;

const DOCKER_COMPOSE = `version: "3.8"

services:
  app:
    image: \${IMAGE_NAME:-myapp}:\${IMAGE_TAG:-latest}
    build:
      context: ../..
      dockerfile: .dockflow/docker/Dockerfile
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
    deploy:
      replicas: 2
      update_config:
        parallelism: 1
        delay: 10s
        order: start-first
      rollback_config:
        parallelism: 1
        delay: 10s
      restart_policy:
        condition: on-failure
        delay: 5s
        max_attempts: 3
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

# networks:
#   default:
#     external: true
#     name: traefik-public
`;

const DOCKERFILE = `FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application
COPY . .

# Build if needed
# RUN npm run build

EXPOSE 3000

CMD ["node", "index.js"]
`;

const GITIGNORE = `.env.dockflow
*.local
`;

/**
 * Register init command
 */
export function registerInitCommand(program: Command): void {
  program
    .command('init [platform]')
    .description('Initialize project structure')
    .action(withErrorHandler(async (platform?: string) => {
      printHeader('Initialize Project');
      console.log('');

      const projectRoot = getProjectRoot();
      const deploymentDir = join(projectRoot, '.dockflow');

      // Check if already initialized
      if (existsSync(deploymentDir)) {
        printWarning('.dockflow folder already exists');
        const { overwrite } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'overwrite',
            message: 'Do you want to overwrite existing files?',
            default: false,
          },
        ]);
        if (!overwrite) {
          printInfo('Initialization cancelled');
          return;
        }
      }

      // Ask for platform if not provided
      let ciPlatform = platform;
      if (!ciPlatform) {
        const answer = await inquirer.prompt([
          {
            type: 'list',
            name: 'platform',
            message: 'Select CI/CD platform:',
            choices: [
              { name: 'GitHub Actions', value: 'github' },
              { name: 'GitLab CI', value: 'gitlab' },
            ],
          },
        ]);
        ciPlatform = answer.platform;
      }

      // Create directory structure
      printInfo('Creating directory structure...');
      
      const dirs = [
        '.dockflow',
        '.dockflow/docker',
        '.dockflow/hooks',
      ];

      for (const dir of dirs) {
        const fullPath = join(projectRoot, dir);
        if (!existsSync(fullPath)) {
          mkdirSync(fullPath, { recursive: true });
        }
      }

      // Create config.yml
      writeFileSync(join(deploymentDir, 'config.yml'), CONFIG_YML);
      printSuccess('Created .dockflow/config.yml');

      // Create servers.yml
      writeFileSync(join(deploymentDir, 'servers.yml'), SERVERS_YML);
      printSuccess('Created .dockflow/servers.yml');

      // Create docker-compose.yml
      writeFileSync(join(deploymentDir, 'docker', 'docker-compose.yml'), DOCKER_COMPOSE);
      printSuccess('Created .dockflow/docker/docker-compose.yml');

      // Create accessories.yml
      writeFileSync(join(deploymentDir, 'docker', 'accessories.yml'), ACCESSORIES_YML);
      printSuccess('Created .dockflow/docker/accessories.yml');

      // Create Dockerfile
      writeFileSync(join(deploymentDir, 'docker', 'Dockerfile'), DOCKERFILE);
      printSuccess('Created .dockflow/docker/Dockerfile');

      // Create CI/CD config
      if (ciPlatform === 'github') {
        const workflowDir = join(projectRoot, '.github', 'workflows');
        if (!existsSync(workflowDir)) {
          mkdirSync(workflowDir, { recursive: true });
        }
        writeFileSync(join(workflowDir, 'ci.yml'), getGithubWorkflow(DOCKFLOW_VERSION));
        printSuccess('Created .github/workflows/ci.yml');
      } else if (ciPlatform === 'gitlab') {
        writeFileSync(join(projectRoot, '.gitlab-ci.yml'), GITLAB_CI);
        printSuccess('Created .gitlab-ci.yml');
      }

      // Update .gitignore
      const gitignorePath = join(projectRoot, '.gitignore');
      if (existsSync(gitignorePath)) {
        const content = await Bun.file(gitignorePath).text();
        if (!content.includes('.env.dockflow')) {
          writeFileSync(gitignorePath, content + '\n' + GITIGNORE);
          printSuccess('Updated .gitignore');
        }
      } else {
        writeFileSync(gitignorePath, GITIGNORE);
        printSuccess('Created .gitignore');
      }

      console.log('');
      printSuccess('Project initialized successfully!');
      console.log('');
      printInfo('Next steps:');
      console.log('  1. Edit .dockflow/config.yml with your project name');
      console.log('  2. Edit .dockflow/servers.yml to define your servers');
      console.log('  3. Configure .dockflow/docker/docker-compose.yml');
      console.log('  4. Update .dockflow/docker/Dockerfile for your app');
      console.log('  5. Run "dockflow setup" to configure your server');
      console.log('  6. Add connection secrets to your CI/CD (e.g., PRODUCTION_MAIN_SERVER_CONNECTION)');
      console.log('  7. Push a tag to trigger deployment');
    }));
}
