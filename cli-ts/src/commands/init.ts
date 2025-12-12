/**
 * Init command
 * Initialize project structure (native, no Docker needed)
 */

import type { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'fs';
import { join } from 'path';
import inquirer from 'inquirer';
import { getProjectRoot } from '../utils/config';
import { printError, printSuccess, printInfo, printHeader, printWarning } from '../utils/output';

const GITHUB_WORKFLOW = `name: Deploy

on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:
    inputs:
      environment:
        description: 'Environment to deploy to'
        required: true
        default: 'production'
        type: choice
        options:
          - production
          - staging

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Extract version from tag
        id: version
        run: |
          if [ "\${{ github.event_name }}" = "workflow_dispatch" ]; then
            echo "version=manual-\$(date +%Y%m%d%H%M%S)" >> $GITHUB_OUTPUT
            echo "env=\${{ github.event.inputs.environment }}" >> $GITHUB_OUTPUT
          else
            echo "version=\${GITHUB_REF#refs/tags/v}" >> $GITHUB_OUTPUT
            echo "env=production" >> $GITHUB_OUTPUT
          fi

      - name: Deploy
        run: |
          docker run --rm \\
            -v \${{ github.workspace }}:/project \\
            -e \${{ steps.version.outputs.env }}_CONNECTION=\${{ secrets[format('{0}_CONNECTION', steps.version.outputs.env)] }} \\
            shawiizz/dockflow-cli:latest \\
            deploy \${{ steps.version.outputs.env }} \${{ steps.version.outputs.version }}
`;

const GITLAB_CI = `stages:
  - deploy

deploy:
  stage: deploy
  image: shawiizz/dockflow-cli:latest
  script:
    - |
      if [ -n "$CI_COMMIT_TAG" ]; then
        VERSION="\${CI_COMMIT_TAG#v}"
        ENV="production"
      else
        VERSION="manual-$(date +%Y%m%d%H%M%S)"
        ENV="\${DEPLOY_ENV:-production}"
      fi
      deploy $ENV $VERSION
  rules:
    - if: $CI_COMMIT_TAG
    - if: $CI_PIPELINE_SOURCE == "web"
      when: manual
`;

const CONFIG_YML = `# Dockflow Configuration
# See https://dockflow.shawiizz.dev/configuration for full documentation

project_name: "my-app"

# Registry configuration (optional)
# registry:
#   type: dockerhub  # dockerhub, ghcr, gitlab, custom
#   username: "{{ env.REGISTRY_USERNAME }}"
#   password: "{{ env.REGISTRY_PASSWORD }}"

# Build options
options:
  remote_build: false      # Build on remote server instead of locally
  environmentize: true     # Create environment-specific image tags

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

const ENV_FILE = `# Environment configuration
# These values can be overridden by CI secrets prefixed with [ENV]_

# Server connection (can be set via [ENV]_CONNECTION secret)
# DOCKFLOW_HOST=192.168.1.10
# DOCKFLOW_PORT=22
# DOCKFLOW_USER=dockflow

# Application environment variables
# DB_HOST=localhost
# DB_PORT=5432
`;

const DOCKER_COMPOSE = `version: "3.8"

services:
  app:
    image: \${IMAGE_NAME:-myapp}:\${IMAGE_TAG:-latest}
    build:
      context: ../..
      dockerfile: .deployment/docker/Dockerfile
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
    .action(async (platform?: string) => {
      printHeader('Initialize Project');
      console.log('');

      const projectRoot = getProjectRoot();
      const deploymentDir = join(projectRoot, '.deployment');

      // Check if already initialized
      if (existsSync(deploymentDir)) {
        printWarning('.deployment folder already exists');
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
        '.deployment',
        '.deployment/docker',
        '.deployment/env',
        '.deployment/hooks',
      ];

      for (const dir of dirs) {
        const fullPath = join(projectRoot, dir);
        if (!existsSync(fullPath)) {
          mkdirSync(fullPath, { recursive: true });
        }
      }

      // Create config.yml
      writeFileSync(join(deploymentDir, 'config.yml'), CONFIG_YML);
      printSuccess('Created .deployment/config.yml');

      // Create docker-compose.yml
      writeFileSync(join(deploymentDir, 'docker', 'docker-compose.yml'), DOCKER_COMPOSE);
      printSuccess('Created .deployment/docker/docker-compose.yml');

      // Create Dockerfile
      writeFileSync(join(deploymentDir, 'docker', 'Dockerfile'), DOCKERFILE);
      printSuccess('Created .deployment/docker/Dockerfile');

      // Create env files
      writeFileSync(join(deploymentDir, 'env', '.env.production'), ENV_FILE);
      printSuccess('Created .deployment/env/.env.production');

      // Create CI/CD config
      if (ciPlatform === 'github') {
        const workflowDir = join(projectRoot, '.github', 'workflows');
        if (!existsSync(workflowDir)) {
          mkdirSync(workflowDir, { recursive: true });
        }
        writeFileSync(join(workflowDir, 'deploy.yml'), GITHUB_WORKFLOW);
        printSuccess('Created .github/workflows/deploy.yml');
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
      console.log('  1. Edit .deployment/config.yml with your project name');
      console.log('  2. Configure .deployment/docker/docker-compose.yml');
      console.log('  3. Update .deployment/docker/Dockerfile for your app');
      console.log('  4. Run "dockflow setup" to configure your server');
      console.log('  5. Add the connection string to .env.dockflow');
      console.log('  6. Push a tag to trigger deployment');
    });
}
