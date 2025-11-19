#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

CLI_VERSION="1.0.0"
CLI_NAME="Dockflow CLI"

# Detect if running in Docker or natively
if [ -f "/.dockerenv" ] || grep -q docker /proc/1/cgroup 2>/dev/null; then
    # Running in Docker container
    export CLI_PROJECT_DIR="/project"
    export CLI_ROOT_DIR="/setup/cli"
    export CLI_EXAMPLE_DIR="/setup/example"
    export RUNNING_IN_DOCKER=true
else
    # Running natively
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    export CLI_ROOT_DIR="$SCRIPT_DIR"
    export CLI_PROJECT_DIR="$(pwd)"
    export CLI_EXAMPLE_DIR="$(cd "$SCRIPT_DIR/../example" && pwd)"
    export RUNNING_IN_DOCKER=false
fi

export CLI_COMMANDS_DIR="$CLI_ROOT_DIR/commands"
export CLI_UTILS_DIR="$CLI_ROOT_DIR/utils"
