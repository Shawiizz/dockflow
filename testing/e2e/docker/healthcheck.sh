#!/bin/bash

echo "--- Running Health Check ---"

# Check 1: SSH Server
if ! nc -z localhost 22; then
	echo "[FAIL] SSH server is not listening on port 22."
	exit 1
else
	echo "[OK] SSH server is active."
fi

# Check 2: Docker Daemon
if ! docker info >/dev/null 2>&1; then
	echo "[FAIL] Docker daemon is not responding."
	exit 1
else
	echo "[OK] Docker daemon is running."
fi

echo "--- Health Check Passed ---"
exit 0
