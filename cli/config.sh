#!/bin/bash

export CLI_VERSION="1.0.0"
export CLI_NAME="Dockflow CLI"

# Always determine the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Detect if running in Docker or natively
if [ -f "/.dockerenv" ] || grep -q docker /proc/1/cgroup 2>/dev/null; then
	# Running in Docker container

	# Check if we are running in the official Dockflow CLI image
	if [ -d "/tmp/dockflow/cli" ] && [[ "$SCRIPT_DIR" == "/tmp/dockflow/cli" ]]; then
		export CLI_ROOT_DIR="/tmp/dockflow/cli"
		export CLI_PROJECT_DIR="/project"
		export CLI_EXAMPLE_DIR="/tmp/dockflow/example"
	else
		# Running in a generic container (e.g. CI/CD, tests)
		export CLI_ROOT_DIR="$SCRIPT_DIR"
		CLI_PROJECT_DIR="$(pwd)"
		export CLI_PROJECT_DIR
		CLI_EXAMPLE_DIR="$(cd "$SCRIPT_DIR/../example" && pwd)"
		export CLI_EXAMPLE_DIR
	fi

	export RUNNING_IN_DOCKER=true
else
	# Running natively
	export CLI_ROOT_DIR="$SCRIPT_DIR"
	# Use DOCKFLOW_WORKING_DIR if set (from launcher), otherwise use current directory
	CLI_PROJECT_DIR="${DOCKFLOW_WORKING_DIR:-$(pwd)}"
	export CLI_PROJECT_DIR
	CLI_EXAMPLE_DIR="$(cd "$SCRIPT_DIR/../example" && pwd)"
	export CLI_EXAMPLE_DIR
	export RUNNING_IN_DOCKER=false
fi

export CLI_COMMANDS_DIR="$CLI_ROOT_DIR/commands"
export CLI_UTILS_DIR="$CLI_ROOT_DIR/utils"
