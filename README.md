## Deployment

The deployment of Docker applications on a server is handled via GitLab/GitHub CI/CD and Ansible. This allows for easy and efficient deployment of Docker applications to a production server.     

### When does deployment occur?

By default, when a tag is created on any branch, but you can customize it.    
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

Add the private key to the `ssh/configure_host_private_key` file in this repository (**DO NOT PUSH IT**), it will be used in the next step.

### Launch the playbook

The playbook will install and configure the following services:
- Docker
- Nginx
- Portainer

To launch the playbook, run the following command, replacing the values accordingly:
```bash
docker compose run --rm \
  -e PORTAINER_PASSWORD=your_password \
  -e PORTAINER_HTTP_PORT=9000 \
  -e PORTAINER_DOMAIN_NAME=portainer.domain.com \
  -e HOST=the_ip_of_your_vm \
  -e ANSIBLE_BECOME_PASSWORD=ansible_user_password \
  -e ANSIBLE_USER=ansible ansible
```
*On Windows, you may need to use the command on one line, as the `\` character may not work as expected.*

**The machine is now ready to receive deployments of any Docker applications.**

## Configure the CI

The CI is configured to build the Docker images and deploy them to the server.      

### Steps to configure the CI

*Example files are provided in the `example` directory.*        

1. Copy the CI configuration file (localed at `examples/ci` directory) to your repository:

**GitHub users**:       
    - Copy the `build_and_deploy.yml` file to the `.github/workflows` directory of your repository.     
    - Fork this repository to your own account or the organization where the repository is and replace the `uses` url by yours inside the `build_and_deploy.yml` file.          
**GitLab users** - Copy the `.gitlab-ci.yml` file to the root directory of your repository.

2. Create the folder structure below at the root of your repository:
```
deployment/
├── docker/
│   ├── compose-deploy.yml
│   └── Dockerfile.[service_name]
└── env/
    └── .env.[your_env_name]
```
* Replace `[service_name]` with the name of your service inside `compose-deploy.yml` file (e.g., `app`, `api`, etc.).
* Replace `[your_env_name]` with the name of your environment (e.g., `production`, `staging`, etc.).

In your repository actions secrets, add the following variables:
- `ANSIBLE_BECOME_PASSWORD`: the password of the ansible user
- `[YOUR_ENV_NAME]_SSH_PRIVATE_KEY`: the private key of the ansible user for your environment

* Make sure all the secrets are in UPPERCASE.

### Example of a `.env.[your_env_name]` file

**Deploy specific docker services**   
To specify which Docker services to build and deploy, use `DEPLOY_DOCKER_SERVICES=service_name_1,service_name_2`.

**Deploy Nginx configs**        
To deploy custom Nginx configs, create the template inside `deployment/templates/nginx/config_name.conf.j2`.

**Deploy SSH private keys**   
To deploy ssh private keys files to your VM, create a CI secret (e.g. `SSH_PRIVATE_KEY_VM_BLABLA`) and in your `.env.[YOUR_ENV_NAME]`, use `DEPLOY_PRIVATE_SSH_KEYS=CI_SECRET_NAME_1,CI_SECRET_NAME_2` (replace with your own variables names).         

**Deploy linux services**       
To deploy custom Linux services, create the template inside `deployment/templates/services/service_name.service.j2`.

## Image for ci 

A pre-made docker image containing Docker, Ansible, NodeJS and the module for extracting docker commands is available at `shawiizz/devops-ci:latest`.        

Building : 
```bash
docker build -t shawiizz/devops-ci:latest -f Dockerfile.ci .
```

Publishing to DockerHub : 
```bash
docker login
docker push shawiizz/devops-ci:latest
```
