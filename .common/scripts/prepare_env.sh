#!/bin/bash

# Prepare environment for Ansible playbooks
# This script is shared between deploy and build commands
#
# Context is now provided via /tmp/dockflow_context.json (mounted by CLI)
# This script handles workspace setup and line ending conversion only.

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

# Check if context file exists (new approach)
CONTEXT_FILE="/tmp/dockflow_context.json"
if [ -f "$CONTEXT_FILE" ]; then
	echo "Using context from $CONTEXT_FILE"
else
	echo "Warning: No context file found at $CONTEXT_FILE"
	echo "Context should be provided by the CLI via Docker mount"
fi
