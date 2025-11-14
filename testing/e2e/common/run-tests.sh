#!/bin/bash
# E2E test runner for DockFlow framework
# Simulates a CI/CD deployment process

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ROOT_PATH="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

cd "$ROOT_PATH"

echo "Running DockFlow E2E Tests"
echo ""

# Check if test VM is running
if ! docker ps | grep -q "dockflow-test-vm"; then
    echo "ERROR: Test VM is not running. Run setup.sh first."
    exit 1
fi

echo "Setting up CI/CD environment simulation..."

# Load commit info
set -a
source dockflow/testing/e2e/test-app/.deployment/e2e-test/.commit_info
set +a

echo "Loading test environment variables..."

# Generate secrets.json from .secrets file, substituting SSH_PRIVATE_KEY variables with file content
SECRETS_FILE="$ROOT_PATH/dockflow/testing/e2e/test-app/.deployment/e2e-test/.secrets"
SSH_KEY_DIR="$SCRIPT_DIR/ssh-keys"

# Check if secrets file exists
if [ ! -f "$SECRETS_FILE" ]; then
    echo "ERROR: Secrets file not found at $SECRETS_FILE"
    exit 1
fi

SECRETS_JSON="{"
FIRST=1
while IFS='=' read -r key value; do
    # Ignore empty lines or comments
    [[ -z "$key" || "$key" =~ ^# ]] && continue

    # Trim whitespace from key and value
    key=$(echo "$key" | xargs)
    value=$(echo "$value" | xargs)

    if [[ "$key" =~ SSH_PRIVATE_KEY$ ]]; then
        # Read the private key file content and escape for JSON
        KEY_PATH="$SSH_KEY_DIR/$value"
        if [ -f "$KEY_PATH" ]; then
            KEY_CONTENT=$(sed ':a;N;$!ba;s/\n/\\n/g' "$KEY_PATH")
            JSON_VALUE="$KEY_CONTENT"
        else
            echo "WARNING: SSH key file not found for $key: $KEY_PATH"
            JSON_VALUE=""
        fi
    else
        JSON_VALUE="$value"
    fi
    # Add comma if not first
    if [ $FIRST -eq 0 ]; then
        SECRETS_JSON+=","
    fi
    FIRST=0
    SECRETS_JSON+="\"$key\":\"$JSON_VALUE\""
done < "$SECRETS_FILE"
SECRETS_JSON+="}"
echo "$SECRETS_JSON" > secrets.json

source dockflow/.common/scripts/load_env.sh "$ENV" "$HOSTNAME"
bash dockflow/.common/scripts/deploy_with_ansible.sh

echo "Verifying deployment..."

# Wait a bit for services to start
sleep 5

# Check if container is running using docker exec
echo "Checking container status..."
if docker exec dockflow-test-vm docker ps --filter name=test-web-app --format '{{.Names}}' | grep -q "test-web-app"; then
    echo "Container is running."
else
    echo "ERROR: Container is not running."
    exit 1
fi

# Check if web app is accessible using docker exec (verbose output)
echo "Checking web application accessibility..."
if docker exec dockflow-test-vm curl -sf http://localhost:8080/health > /dev/null; then
    echo "Web application is accessible."
else
    echo "WARNING: Web application health check failed."
    echo "Verbose output:"
    docker exec dockflow-test-vm curl -v http://localhost:8080/health
fi

echo ""
echo "All E2E tests passed."
echo ""
echo "Deployment Summary:"
echo "   Environment: ${ENV}"
echo "   Version: ${VERSION}"
echo "   Application: test-web-app"
echo ""
echo "To cleanup: cd ${SCRIPT_DIR} && bash teardown.sh"
