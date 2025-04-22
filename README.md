# Deployment

The deployment of Docker applications on a server is handled via an Ansible playbook. A GitHub CI has to be set up and will automatically deploy the applications using the Ansible configuration from this repository.  
To function properly, this repository is configured as a submodule in the app's repositories.

There are two deployment environments (you can add more if needed):
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

When a tag is created on the backend or frontend repositories.  
See the versioning convention below:
- `X.Y.Z`: deploys to production
- `X.Y.Z-rc`: deploys to the staging environment

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
