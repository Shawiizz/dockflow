#!/bin/bash

# Check SSH server
if ! nc -z localhost 22; then
    exit 1
fi

# Check k3s is running and nodes are ready
if [ "${K3S_ROLE}" = "server" ]; then
    if ! k3s kubectl get nodes >/dev/null 2>&1; then
        exit 1
    fi
fi

exit 0
