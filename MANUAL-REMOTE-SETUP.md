# Manual Server Configuration

This guide explains how to manually set up your server without using the automated CLI tool.

## 1. Create Deployment User

Run these commands on your target server:

```bash
# Create deployment user
sudo useradd deploy

# Add user to sudo group
sudo adduser deploy sudo

# Set password (save this password securely)
sudo passwd deploy
```

## 2. Configure SSH Access

```bash
# Create .ssh directory
sudo mkdir -p /home/deploy/.ssh

# Set correct permissions
sudo chown -R deploy:deploy /home/deploy/

# Add your public SSH key to authorized_keys
sudo echo "YOUR_PUBLIC_KEY" >> /home/deploy/.ssh/authorized_keys
```

> **Important**: Store the private key securely - you'll need it for CI/CD deployment configuration.

## 3. Additional Setup

Unlike the automated CLI, which can install Nginx and Portainer automatically, you'll need to set up these components manually:

1. Install Docker (and Docker Compose)
2. Install and configure Nginx for reverse proxy (if needed)
3. Set up Portainer for container management (if needed)

After completing these steps, your server will be ready to receive Docker application deployments through the CI/CD pipeline.