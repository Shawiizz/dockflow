#!/bin/bash
# =============================================================================
# Dockflow Container Entrypoint
# =============================================================================
#
# This entrypoint:
# 1. Sets up the workspace with symlinks (protects source files)
# 2. Fixes CRLF line endings in .dockflow files
# 3. Executes the command passed (ansible-playbook ...)
#
# All configuration is provided via:
# - /tmp/dockflow_context.json (mounted by CLI)
# - /tmp/dockflow_key (SSH key, mounted by CLI for deploy)
# =============================================================================

set -e

DOCKFLOW_PATH="${DOCKFLOW_PATH:-/tmp/dockflow}"

# Default ROOT_PATH to /project (will be updated by setup_workspace.sh if needed)
export ROOT_PATH="${ROOT_PATH:-/project}"

# Setup workspace with symlinks (skip in CI where files are cloned, not mounted)
if [ "$CI" != "true" ] && [ -f "$DOCKFLOW_PATH/.common/scripts/setup_workspace.sh" ]; then
    source "$DOCKFLOW_PATH/.common/scripts/setup_workspace.sh"
    # ROOT_PATH is now /workspace (set by setup_workspace.sh)
else
    [ "$CI" = "true" ] && echo "CI detected, skipping workspace setup (files are not mounted)"
fi

# Fix CRLF line endings in .dockflow files (Windows compatibility)
if [ -d "$ROOT_PATH/.dockflow" ]; then
    find "$ROOT_PATH/.dockflow" -type f -exec sed -i 's/\r$//' {} \; 2>/dev/null || true
fi

# Change to dockflow directory (where ansible playbooks are)
cd "$DOCKFLOW_PATH"

# Execute the command passed to the container
exec "$@"
