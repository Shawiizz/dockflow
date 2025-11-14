#!/bin/bash
set -eo pipefail

# Function to log messages
log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

# 1. Start Docker Daemon
log "Starting Docker daemon..."
dockerd \
    --host=unix:///var/run/docker.sock \
    --host=tcp://0.0.0.0:2375 \
    --tls=false &

# 2. Wait for Docker Daemon to be ready
log "Waiting for Docker daemon to initialize..."
for i in {1..30}; do
    if docker info >/dev/null 2>&1; then
        log "Docker daemon is ready."
        break
    fi
    if [ $i -eq 30 ]; then
        log "ERROR: Docker daemon failed to start within 30 seconds."
        exit 1
    fi
    sleep 1
done

# 3. Install SSH public key
if [ -f /ssh-keys/deploy_key.pub ]; then
    log "Installing SSH public key..."
    SSH_USER="${SSH_USER:-deploy}"
    
    # Determine SSH directory based on user
    if [ "${SSH_USER}" = "root" ]; then
        SSH_DIR="/root/.ssh"
    else
        SSH_DIR="/home/${SSH_USER}/.ssh"
    fi
    
    mkdir -p "${SSH_DIR}"
    cat /ssh-keys/deploy_key.pub >> "${SSH_DIR}/authorized_keys"
    chmod 700 "${SSH_DIR}"
    chmod 600 "${SSH_DIR}/authorized_keys"
    
    # Only chown if not root (root already owns /root)
    if [ "${SSH_USER}" != "root" ]; then
        chown -R "${SSH_USER}:${SSH_USER}" "${SSH_DIR}"
    fi
    
    log "SSH key installed for user '${SSH_USER}'."
fi

# 4. Prepare deployment log file
log "Preparing deployment log file..."
mkdir -p /var/log/deployment
touch /var/log/deployment/deployment.log
chmod 666 /var/log/deployment/deployment.log

# 5. Start SSH Server
log "Starting SSH server..."
log "Container is ready. Listening on:"
log "  - SSH: port 22"
log "  - Docker API: port 2375"

exec /usr/sbin/sshd -D -e
