#!/bin/bash

# Check SSH server
if ! nc -z localhost 22; then
    exit 1
fi

# Check Docker daemon
if ! docker info >/dev/null 2>&1; then
    exit 1
fi

# If manager, check Swarm is initialized
if [ "${SWARM_ROLE}" = "manager" ]; then
    if ! docker node ls >/dev/null 2>&1; then
        exit 1
    fi
fi

exit 0
