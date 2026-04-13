#!/bin/bash

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

K3S_TOKEN="${K3S_TOKEN:-dockflow-e2e-token}"
KUBECONFIG_SRC="/etc/rancher/k3s/k3s.yaml"
KUBECONFIG_DST="/var/lib/dockflow/k3s.yaml"

if [ "${K3S_ROLE}" = "server" ]; then
    log "Starting k3s server..."
    k3s server \
        --token "$K3S_TOKEN" \
        --write-kubeconfig-mode 644 \
        --disable traefik \
        --snapshotter native \
        --kube-apiserver-arg="--anonymous-auth=true" &

    # Wait for k3s to be ready
    for i in {1..120}; do
        if [ -f "$KUBECONFIG_SRC" ] && k3s kubectl get nodes >/dev/null 2>&1; then
            log "k3s server is ready."
            break
        fi
        if [ $i -eq 120 ]; then
            log "ERROR: k3s server failed to start within 120 seconds."
            exit 1
        fi
        sleep 1
    done

    # Copy kubeconfig to dockflow path (CLI expects it there)
    cp "$KUBECONFIG_SRC" "$KUBECONFIG_DST"
    chmod 644 "$KUBECONFIG_DST"
    log "Kubeconfig copied to $KUBECONFIG_DST"

elif [ "${K3S_ROLE}" = "agent" ]; then
    K3S_SERVER="${K3S_SERVER_URL:-https://dockflow-test-k3s:6443}"
    log "Starting k3s agent (server=$K3S_SERVER)..."
    k3s agent \
        --server "$K3S_SERVER" \
        --token "$K3S_TOKEN" \
        --snapshotter native &

    # Wait for agent to join
    for i in {1..60}; do
        if pgrep -x "k3s-agent" >/dev/null 2>&1; then
            log "k3s agent started."
            break
        fi
        if [ $i -eq 60 ]; then
            log "ERROR: k3s agent failed to start within 60 seconds."
            exit 1
        fi
        sleep 1
    done
else
    log "ERROR: K3S_ROLE must be 'server' or 'agent'."
    exit 1
fi

# Start SSH server (foreground)
log "Starting SSH server..."
mkdir -p /run/sshd
exec /usr/sbin/sshd -D -e
