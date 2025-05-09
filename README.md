## Deployment

The deployment of Docker applications on a server is handled via GitLab/GitHub CI/CD and Ansible. This allows for easy and efficient deployment of Docker applications to a production server.     
A compose file with a Dockerfile is needed to build the image and deploy it to the server (see steps below).        
Note that built images are not pushed to DockerHub, but are instead built, uploaded as ci artifact and deployed directly to the server. 

### When does deployment occur?

By default, when a tag is created on any branch, but you can customize it.    
See the versioning convention below:
- `X.Y.Z`: deploys to `production` env by default
- `X.Y.Z-[your_env_name]`: deploys to the specified environment

*X is the major version, Y is the minor version, and Z is the patch.*

## Initialize the remote server

The remote server needs to be configured to receive application deployments. The following documentation explains how to install and configure the required services.

On your local machine (Windows or Linux), you have to install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and run it.        

### Prerequisites

The machine must run Debian or Ubuntu. The playbook is not designed for other operating systems.

### Set up the host machine
Execute the following commands to set up the host machine.  

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
Execute the following commands to set up the host machine.

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
*Tip: you can generate a private and public key using `docker-compose -f configure_host/docker-compose.yml run generate_ssh_key` (it will display both keys).*

Add the private key to the `ssh/configure_host_private_key` file in this repository (**DO NOT PUSH IT**), it will be used in the next step.     
Don't forget to add an empty new line at the end of the private key file.

### Run the playbook

The playbook will install and configure the following apps/services:
- Docker
- Nginx
- Portainer (optional)

You are free to setup these services manually, but the playbook will do it for you if you want.
To run the playbook, run the following command (interactive script).        

Linux:
```bash
chmod +x configure_host/setup_services_interactive.sh
sh ./configure_host/setup_services_interactive.sh
```

Windows:
```bash
.\configure_host\setup_services_interactive.bat
```

**The machine is now ready to receive deployments of any Docker applications.**

## Configure the CI/CD

There are three main jobs available in the CI/CD process:
1. **build**: This job builds the Docker image (your project) without uploading it, it can be used to test if your app is building.
2. **deploy-build**: This job builds the Docker image and upload it to the GitHub/GitLab actions artifacts. It will be used by the `deploy` step to deploy the image(s) to the server.
3. **deploy**: This job deploys the Docker image(s) to the server using Ansible.

See the example files in the `examples/ci` directory for more details.

### Steps to configure the CI/CD

*Example files are provided in the `example` directory.*        

1. Copy the CI configuration file (localed at `examples/ci` directory) to your repository:

**GitHub users**:       
    - Copy the `github-ci.yml` file to the `.github/workflows` directory of your repository.     
    - Fork this repository to your own account or the organization where the repository is and replace the `uses` url by yours inside the `github-ci.yml` file.          
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

### Deploy Nginx configs, Linux services and SSH private keys

**Deploy Nginx configs**        
To deploy custom Nginx configs, create the template inside `deployment/templates/nginx/config_name.conf.j2`.

**Deploy linux services**       
To deploy custom Linux services, create the template inside `deployment/templates/services/service_name.service.j2`.

*Note: j2 files are Jinja2 templates. You can use the variables from the `.env.[your_env_name]` file and GitHub/GitLab CI secrets inside them.*

**Deploy SSH private keys**   
*This can be useful if you plan to deploy a systemd service that requires SSH access to another server (a service that mounts a distant folder for example).*
To deploy ssh private keys files to your VM, create a CI secret (e.g. `SSH_PRIVATE_KEY_VM_BLABLA`) and in your `.env.[YOUR_ENV_NAME]`, use `DEPLOY_PRIVATE_SSH_KEYS=CI_SECRET_NAME_1,CI_SECRET_NAME_2` (replace with your own variables names).

### Managing env variables

You can add environment variables to your `compose-deploy.yml` file like a classic Docker compose file.         
You can use any variable from your `.env.[your_env_name]` and any variable from the GitLab/GitHub CI secrets.         
**Env variables will only be added when running container, not when building the image (so it's safe to push the container).**

Example:
```yaml
services:
  app:
    environment:
      ENV: ${ENV}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
```

This will bind the `DB_PASSWORD` variable from the GitLab/GitHub CI secrets or your env file to the `POSTGRES_PASSWORD` variable in the container,
and it's the same for the `ENV` variable (it will bind it from `.env.[your_env_name]` file).      

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
