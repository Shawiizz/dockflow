#!/bin/bash


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

# 5. Start SSH Server
log "Starting SSH server..."
log "Container is ready. Listening on:"
log "  - SSH: port 22"
log "  - Docker API: port 2375"

exec /usr/sbin/sshd -D -e
