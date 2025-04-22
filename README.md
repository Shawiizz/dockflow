# Deployment

The deployment of Docker applications on a server is handled via an Ansible playbook. A GitHub / GitLab CI has to be set up and will automatically deploy the applications using the Ansible configuration from this repository.  
To function properly, this repository is configured as a submodule in the app's repositories.

Add the deployment environments you need, for example:
- **Production**: accessible to all users
- **Staging**: used to test new features before releasing them to production

**Set the server IPs in the `hosts` file at the root of this project:**
```ini
[production]
XX.XX.XX.XX ansible_user=ansible ansible_ssh_private_key_file=ssh/production_private_key

[staging]
XX.XX.XX.XX ansible_user=ansible ansible_ssh_private_key_file=ssh/staging_private_key
```

### When does deployment occur?

When a tag is created on any branch.    
See the versioning convention below:
- `X.Y.Z`: deploys to production
- `X.Y.Z-[your_env_name]`: deploys to the specified environment

*X is the major version, Y is the minor version, and Z is the patch.*

## Initialize the production server

The production server needs to be configured to receive application deployments. The following documentation explains how to install and configure the required services.

### Prerequisites

The machine must run Debian or Ubuntu. The playbook is not designed for other operating systems.

### Set up the machine

Create the ansible user:
```bash
sudo useradd ansible
```

Add the user to the sudo group:
```bash
sudo adduser ansible sudo
```

Set the password for the ansible user (make sure to remember it):
```bash
sudo passwd ansible
```

### Configure SSH access

Create the `.ssh` folder:
```bash
sudo mkdir -p /home/ansible/.ssh
```

Update permissions for the home directory:
```bash
sudo chown -R ansible:ansible /home/ansible/
```

Generate an SSH key on your PC, then copy the public key to the server using:
```bash
sudo echo "YOUR_PUBLIC_KEY" >> /home/ansible/.ssh/authorized_keys
```
*Tip: you can generate a private and public key using `docker-compose run generate_ssh_key` (it will display both keys).*

### Run the playbook to set up the services

The playbook will install and configure the following services:
- Docker
- Nginx
- Portainer

#### Launch the playbook

To launch the playbook, run the following command, replacing the values accordingly:
```bash
docker compose run --rm \
  -e PORTAINER_PASSWORD=your_password \
  -e PORTAINER_HTTP_PORT=9000 \
  -e PORTAINER_DOMAIN_NAME=portainer.domain.com \
  -e ANSIBLE_BECOME_PASSWORD=ansible_user_password \
  -e HOST=production|staging ansible
```

**The machine is now ready to receive deployments of any Docker applications.**

## Configure the CI

The CI is configured to build the Docker images and deploy them to the server. The CI configuration files are located in the `.github/workflows` directory for GitHub and in the `.gitlab-ci.yml` file for GitLab.      
*Note: you can find workflows working examples in the `example/workflows` directory of this repository.*

### Steps to configure the CI

*Example files are provided in the `example` directory.*        

1. In your GitHub / GitLab repository, copy the workflow example in `.github/workflows/deploy.yml` or `.gitlab-ci.yml`.
2. Create a compose-deploy.yml file in the root of your repository. This file will be used to build the Docker images.
3. Create your Dockerfile to build your application.
4. Create a `.env.[your_env_name]` file in the root of your repository. This file will be used to set the environment variables for the CI.
5. Initialize the submodule in your repository (example file can be found in `example/.gitmodules`)
```bash
git submodule init
git submodule update
```

In your repository actions secrets, add the following variables:
- `ANSIBLE_BECOME_PASSWORD`: the password of the ansible user
- `[YOUR_ENV_NAME]_SSH_PRIVATE_KEY`: the private key of the ansible user for your environment
- `SUBMODULE_REPOSITORY_TOKEN`: the token to access the submodule repository (if needed)

**Deploy specific docker services**   
To specify which Docker services to build and deploy, use `DEPLOY_DOCKER_SERVICES=service_name_1,service_name_2` in your `.env.[YOUR_ENV_NAME]` (replace with the services names). 

**Deploy Nginx configs**
To deploy custom Nginx configs, create the template inside `roles/nginx/templates/config_name.conf.j2` and then, use `DEPLOY_NGINX_CONFIGS=config_name_1,config_name_2` in your `.env.[YOUR_ENV_NAME]` (without including `.conf.j2` in the config names).

**Deploy SSH private keys**   
To deploy ssh private keys files to your VM, create a CI secret (e.g. `SSH_PRIVATE_KEY_VM_BLABLA`) and in your `.env.[YOUR_ENV_NAME]`, use `DEPLOY_PRIVATE_SSH_KEYS=CI_SECRET_NAME_1,CI_SECRET_NAME_2` (replace with your own variables names).         

**Deploy linux services**
To deploy custom Linux services, create the template inside `roles/services/templates/service_name.service.j2` and then, use `DEPLOY_LINUX_SERVICES=service_name_1,service_name_2` in your `.env.[YOUR_ENV_NAME]` (without including `.service.j2` in the config names).
