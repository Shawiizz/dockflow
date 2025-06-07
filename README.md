<div align="center">

# 🚀 DevOps Deployment Framework

![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![Ansible](https://img.shields.io/badge/Ansible-EE0000?style=for-the-badge&logo=ansible&logoColor=white)
![GitLab CI](https://img.shields.io/badge/GitLab_CI-FC6D26?style=for-the-badge&logo=gitlab&logoColor=white)
![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-2088FF?style=for-the-badge&logo=github-actions&logoColor=white)

**Automated deployment of Docker applications via CI/CD pipelines**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
![Beta Version](https://img.shields.io/badge/Version-BETA-orange)

</div>

> **BETA VERSION**: This project is currently in beta. While it is functional and being used in production environments, you may encounter issues. Please report any bugs or suggestions for improvement.

This framework automates Docker application deployments to servers using GitLab/GitHub CI/CD and Ansible.

## ✨ Key Features

- 🔄 **Automated Workflow**: Build, test and deploy with a single tag
- 🔌 **Multi-Environment**: Deploy to different environments with versioning tags
- 🔧 **Zero Configuration**: Server setup with a single command
- 📦 **Containerized**: Everything runs in containers for consistency
- 🔒 **Secure**: SSH keys and secrets management built-in
- 🚦 **Flexible CI/CD**: Support for both GitHub Actions and GitLab CI

---

## 🔄 Deployment Workflow

1. 🏗️ A Docker image is built from your Dockerfile
2. 📤 The image is uploaded as a CI artifact (not to DockerHub)
3. 🚀 Ansible deploys the image to your target server

### 🏷️ Deployment Triggers

Deployments are triggered when you create a git tag following this versioning convention:
- `X.Y.Z`: Deploys to `production` environment
- `X.Y.Z-[env_name]`: Deploys to the specified environment

*Where X=major version, Y=minor version, Z=patch version*

## 🖥️ Initial Server Setup

### 📋 Prerequisites

- 🖧 **Remote server**: Debian or Ubuntu only
- 💻 **Local machine**: [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running

### ⚙️ Server Configuration

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

## 🔄 CI/CD Configuration

### 🔧 Available CI/CD Jobs

1. 🧪 **build**: Tests your Docker image build process without uploading
2. 🏗️ **deploy-build**: Builds and uploads the Docker image as a CI artifact
3. 🚀 **deploy**: Deploys the image to your server using Ansible
4. ⚡ **build-and-deploy**: Combines the build and deploy steps into a single job (faster deployment without artifact storage)

> **Direct Build & Deploy Mode**: The `build-and-deploy` job builds Docker images and deploys them directly without storing them as artifacts. This single-job mode offers:
> - **Pros**: Faster deployment, less CI storage usage, simplified workflow
> - **Cons**: No artifacts for debugging, cannot reuse built images across jobs, less suitable for complex deployments


### 📝 Setup Instructions

1. 📄 **Copy CI Configuration File**:
   - <img src="https://github.com/fluidicon.png" width="16" height="16"> **GitHub**: Copy `example/ci/github-ci.yml` → `.github/workflows/` directory
     - ⚠️ **Important note**: Fork this repository and update the `uses` URL in the workflow file
   - <img src="https://about.gitlab.com/images/press/logo/png/gitlab-icon-rgb.png" width="16" height="16"> **GitLab**: Copy `example/ci/gitlab-ci.yml` → root of your repository

2. **Create Project Structure**:
   ```
   deployment/
   ├── docker/
   │   ├── compose-deploy.yml
   │   └── Dockerfile.[service_name]
   └── env/
       └── .env.[env_name]
   ```
   - Replace `[service_name]` with your service name (e.g., `app`, `api`)
   - Replace `[env_name]` with your environment (e.g., `production`, `staging`)

3. **Add Repository Secrets**:
   - `ANSIBLE_BECOME_PASSWORD`: Ansible user password
   - `[ENV_NAME]_SSH_PRIVATE_KEY`: SSH private key for each environment

   **Note**: All secret names must be in UPPERCASE
   **Second Note**: On GitLab, secrets **must not be marked as protected**

## 🛠️ Advanced Configuration

### 📐 Custom Deployment Templates

#### 🌐 Nginx Configurations
Create templates at: `deployment/templates/nginx/[config_name].conf.j2`

#### 🐧 Linux Services
Create templates at: `deployment/templates/services/[service_name].[service|mount].j2`

#### 🔑 SSH Private Keys
To deploy SSH keys (useful for services requiring remote access):
1. Create CI secret (e.g., `SSH_PRIVATE_KEY_VM_NAME`) 
2. Add to your environment file: 
   ```
   DEPLOY_PRIVATE_SSH_KEYS=SECRET_NAME_1,SECRET_NAME_2
   ```

> **Note**: All templates use Jinja2 format (`.j2`) and can access variables from `.env.[env_name]` and CI secrets

### 🔐 Environment Variables

Environment variables in `compose-deploy.yml` can reference:
- 📄 Values from your `.env.[env_name]` file
- 🔒 Values from GitLab/GitHub CI secrets

**Example**:
```yaml
services:
  app:
    environment:
      ENV: ${ENV}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
```

> **Security Note**: Environment variables are only added when running the container, not during image building, except if you add them manually inside the Dockerfile.

---

<div align="center">

## 🤝 Contributing

Contributions are welcome! Please check out our [contribution guidelines](./CONTRIBUTE.MD).

## 📜 License

This project is licensed under the MIT License.

<p>Built with ❤️ for the DevOps community</p>

</div>