<div align="center">

# DevOps Deployment Framework

![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![Ansible](https://img.shields.io/badge/Ansible-EE0000?style=for-the-badge&logo=ansible&logoColor=white)
![GitLab CI](https://img.shields.io/badge/GitLab_CI-FC6D26?style=for-the-badge&logo=gitlab&logoColor=white)
![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-2088FF?style=for-the-badge&logo=github-actions&logoColor=white)

**Automated deployment of Docker applications via CI/CD pipelines**

[![License](https://img.shields.io/badge/License-MIT-00b0ff.svg?style=for-the-badge&logo=opensourceinitiative&logoColor=white)](https://opensource.org/licenses/MIT)
![Version](https://img.shields.io/badge/Version-BETA-6F42C1?style=for-the-badge&logo=semver&logoColor=white)

</div>

> **BETA VERSION**: This project is currently in beta. While it is functional and being used in production environments, you may encounter issues. Please report any bugs or suggestions for improvement.

This framework automates Docker application deployments to servers using GitLab/GitHub CI/CD and Ansible, supporting single or multiple container deployments from one repository.

## 📑 Table of contents

- [Features](#features)
- [Deployment workflow](#deployment-workflow)
- [Initial server setup](#initial-server-setup)
- [CI/CD configuration](#cicd-configuration)
- [Advanced configuration](#advanced-configuration)
- [Examples from existing projects](#-projects-using-this-framework)
- [Contributing](#contributing)
- [License](#license)

## ✨ Features

- **Automated Workflow**: Build and deploy with a single tag
- **Multi environment**: Deploy to different environments with versioning tags (on the same machine or not)
- **Easy Configuration**: Initial remote server setup with a CLI tool
- **Multi container**: Deploy multiple Docker services from a single repository
- **Environment isolation**: Full separation between environments using ${ENV} variable (useful for deployments on the same server)
- **Secure**: SSH keys and secrets management built-in
- **Flexible CI/CD**: Support for both GitHub Actions and GitLab CI

---

## 🚀 Deployment workflow

1. Docker images are built from your Dockerfiles (defined by a compose file)
2. Images are uploaded as CI artifacts (not to DockerHub)
3. Ansible deploys the images to your target server

> **Multiple services**: This framework supports deploying multiple Docker images/services simultaneously from a single compose file
>
> ```
>  Repository
>  ├── 🐳 Dockerfile.service_a ──┐
>  ├── 🐳 Dockerfile.backend    ─┼─➡ Single deployment process
>  └── 🐳 Dockerfile.db        ──┘
> ```

### 🏷️ Deployment triggers

Deployments are triggered when you create a git tag following this versioning convention:
- `X.Y.Z`: Deploys to `production` environment
- `X.Y.Z-[env_name]`: Deploys to the specified environment

*Where X=major version, Y=minor version, Z=patch version*

## 🛠️ Initial server setup

### Prerequisites

- **Remote server**: Debian or Ubuntu only
- **Local machine**: [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running

### Server configuration

Use the CLI tool to automatically configure your server (recommended):

**Linux**:
```bash
docker run -it --rm \
  -v ~/.ssh:/root/.ssh \
  shawiizz/devops-cli:latest
```

**Windows (PowerShell)**:
```powershell
docker run -it --rm `
  -v ${HOME}/.ssh:/root/.ssh `
  shawiizz/devops-cli:latest
```

For manual server setup, follow the [detailed instructions](./MANUAL-REMOTE-SETUP.md).

## ⚙️ CI/CD configuration

### Available CI/CD jobs

1. **build**: Tests your Docker image build process without uploading
2. **deploy-build**: Builds and uploads the Docker image(s) as a CI artifact
3. **deploy**: Deploys the image(s) to your server using Ansible
4. **build-and-deploy**: Combines the build and deploy steps into a single job (faster deployment without artifact storage)

> **Direct build & deploy mode**: The `build-and-deploy` job builds Docker images and deploys them directly without storing them as artifacts. This single-job mode offers:
> - **Pros**: Faster deployment, less CI storage usage, simplified workflow
> - **Cons**: No artifacts for debugging, cannot reuse built images across jobs, less suitable for complex deployments


### Setup instructions

1. **Copy CI configuration file**:
   - <img src="https://github.com/fluidicon.png" width="16" height="16"> **GitHub**: Copy `example/ci/github-ci.yml` → `.github/workflows/` directory
     - ⚠️ **Important note**: Fork this repository and update the `uses` URL in the workflow file
   - <img src="https://about.gitlab.com/images/press/logo/png/gitlab-icon-rgb.png" width="16" height="16"> **GitLab**: Copy `example/ci/gitlab-ci.yml` → root of your repository

2. **Create project structure**:
   ```
   deployment/
   ├── docker/
   │   ├── compose-deploy.yml
   │   ├── Dockerfile.service1
   │   └── Dockerfile.service2...
   └── env/
       └── .env.[env_name]
   ```
   - Create multiple Dockerfile.[service_name] files for each of your services
   - Replace `[env_name]` with your environment (e.g., `production`, `staging`)
   - Your `compose-deploy.yml` can reference multiple services and images

3. **Add repository secrets**:
   - `ANSIBLE_BECOME_PASSWORD`: Ansible user password
   - `[ENV_NAME]_SSH_PRIVATE_KEY`: SSH private key for each environment

   **Note**: All secret names must be in UPPERCASE      
   **Second note**: On GitLab, secrets **must __not__ be marked as protected**

## 🔧 Advanced configuration

For examples, take a look at `example/deployment` folder.   

### Custom deployment templates

#### 🌐 Nginx configurations
Create templates at: `deployment/templates/nginx/[config_name].conf.j2`

#### 🐧 Linux services
Create templates at: `deployment/templates/services/[service_name].[service|mount].j2`

#### 🔑 SSH private keys
To deploy SSH keys (useful for services requiring remote access. e.g. a mounting point managed by a .mount file):
1. Create CI secret (e.g., `SSH_PRIVATE_KEY_VM_NAME`) 
2. Add to your environment file: 
   ```
   DEPLOY_PRIVATE_SSH_KEYS=SECRET_NAME_1,SECRET_NAME_2
   ```

> **Note**: All templates use Jinja2 format (`.j2`) and can access variables from `.env.[env_name]` and CI secrets

### Environment variables

Environment variables in `compose-deploy.yml` can reference:
- Values from your `.env.[env_name]` file
- Values from GitLab/GitHub CI secrets

**Example**:
```yaml
services:
  app:
    environment:
      ENV: ${ENV} # The current env (specified on the tag, 'production' by default)
      POSTGRES_PASSWORD: ${DB_PASSWORD} # DB_PASSWORD can be defined from CI repository secrets
```

> **Security note**: Environment variables are only added when running the container, not during image building, except if you add them manually inside the Dockerfile.

### Environment isolation with compose-deploy.yml

The `compose-deploy.yml` file supports environment separation using the `${ENV}` variable. This allows you to:

- Create isolated networks for different environments
- Use environment-specific volumes
- Configure services differently per environment
- Differentiate container names, image tags, and ports per environment

**Example included in this repository**:
```yaml
services:
  app:
    image: my-app-${ENV}:${VERSION}
    build:
      context: ../..
      dockerfile: Dockerfile.app
    environment:
      ENV: ${ENV} # Pass the current env to your app through env vars
    restart: always
    ports:
      - "${APP_EXTERNAL_PORT}:3000" # Define APP_EXTERNAL_PORT inside .env.[env_name] file
```

**More complex example with multiple services**:
```yaml
services:
  api:
    image: myapp-api-${ENV}:${VERSION}
    networks:
      - network_${ENV}
    volumes:
      - data_${ENV}:/app/data
    environment:
      NODE_ENV: ${ENV}
      
  frontend:
    image: myapp-frontend-${ENV}:${VERSION}
    networks:
      - network_${ENV}
    environment:
      API_URL: http://api:3000

networks:
  network_${ENV}:
    
volumes:
  data_${ENV}:
```

This ensures complete isolation between environments (production, staging, etc.) when they are deployed on the same server.

---

## 🌟 Projects using this framework

This framework is already being used in some projets. Here are some real-world examples:

- [https://github.com/MohistMC/mohistmc-frontend](https://github.com/MohistMC/mohistmc-frontend)
- [https://github.com/MohistMC/mohistmc-backend](https://github.com/MohistMC/mohistmc-backend)
- [https://github.com/MohistMC/maven](https://github.com/MohistMC/maven)
- [https://github.com/Shawiizz/shawiizz.dev](https://github.com/Shawiizz/shawiizz.dev)

> These projects demonstrate different aspects of the framework's capabilities including custom Nginx configurations, Linux services configurations, environment isolation, and multi-service deployments.

---

<div align="center">

## 👥 Contributing

Contributions are welcome! Please check out our [contribution guidelines](./CONTRIBUTE.md).

## 📄 License

This project is licensed under the MIT License.

<p>Built with ❤️ for the DevOps community</p>

</div>