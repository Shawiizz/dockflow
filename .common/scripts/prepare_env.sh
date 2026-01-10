#!/bin/bash

# Prepare environment for Ansible playbooks
# This script is shared between deploy and build commands
#
# Expected environment variables:
# - ROOT_PATH: The root path of the project (initially /project, becomes /workspace)

set -e

#######################################
######## Setup Workspace ##############
#######################################

# Setup workspace with symlinks to protect source files from modification
# This creates /workspace where .deployment/ is copied and everything else is symlinked
# SKIP in CI/CD: files are cloned, not mounted from host, so no protection needed
DOCKFLOW_PATH="${DOCKFLOW_PATH:-/tmp/dockflow}"
if [ "$CI" != "true" ] && [ -f "$DOCKFLOW_PATH/.common/scripts/setup_workspace.sh" ]; then
    source "$DOCKFLOW_PATH/.common/scripts/setup_workspace.sh"
    # ROOT_PATH is now /workspace (set by setup_workspace.sh)
else
    # In CI/CD, keep ROOT_PATH as-is (files can be modified directly)
    [ "$CI" = "true" ] && echo "CI detected, skipping workspace setup (files are not mounted)"
fi

#######################################
######## Prepare Environment ##########
#######################################

# Convert Windows line endings in .deployment files
if [ -d "$ROOT_PATH/.deployment" ]; then
	find "$ROOT_PATH/.deployment" -type f -exec sed -i 's/\r$//' {} \; 2>/dev/null || true
fi

# Export environment variables to YAML for Ansible
echo "Exporting environment variables to /tmp/ansible_env_vars.yml..."
python3 <<'PYTHON_EOF'
import os, yaml
env_vars = {k.lower(): v for k, v in os.environ.items() if k}
with open('/tmp/ansible_env_vars.yml', 'w') as f:
    yaml.dump(env_vars, f, default_flow_style=False, allow_unicode=True)
PYTHON_EOF
