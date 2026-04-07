#!/bin/bash

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

# Start Docker daemon
log "Starting Docker daemon..."
dockerd \
    --host=unix:///var/run/docker.sock \
    --host=tcp://0.0.0.0:2375 \
    --tls=false &

# Wait for Docker daemon
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

# Auto-initialize Swarm based on node role (set via SWARM_ROLE env)
if [ "${SWARM_ROLE}" = "manager" ]; then
    log "Initializing Swarm manager..."
    ADVERTISE_ADDR=$(hostname -i | awk '{print $1}')
    docker swarm init --advertise-addr "$ADVERTISE_ADDR" 2>/dev/null || true
    # Write join token for workers
    docker swarm join-token worker -q > /swarm/join-token 2>/dev/null || true
    log "Swarm manager initialized. Join token written to /swarm/join-token"
elif [ "${SWARM_ROLE}" = "worker" ]; then
    log "Waiting for Swarm join token..."
    MANAGER_HOST="${SWARM_MANAGER_HOST:-dockflow-test-mgr}"
    for i in {1..60}; do
        if [ -f /swarm/join-token ] && [ -s /swarm/join-token ]; then
            TOKEN=$(cat /swarm/join-token)
            log "Found join token, joining swarm..."
            docker swarm join --token "$TOKEN" "${MANAGER_HOST}:2377" && break
            # If join failed, retry
            sleep 2
        fi
        if [ $i -eq 60 ]; then
            log "ERROR: Could not join Swarm within 60 seconds."
            exit 1
        fi
        sleep 1
    done
    log "Swarm worker joined."
fi

# Start SSH server (foreground)
log "Starting SSH server..."
exec /usr/sbin/sshd -D -e
