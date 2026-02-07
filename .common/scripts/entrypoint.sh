#!/bin/bash
set -e

DOCKFLOW_PATH="${DOCKFLOW_PATH:-/tmp/dockflow}"
export ROOT_PATH="${ROOT_PATH:-/project}"

if [ -f "$DOCKFLOW_PATH/.common/scripts/setup_workspace.sh" ] &&
	[ -d "/project/.dockflow" ]; then
	source "$DOCKFLOW_PATH/.common/scripts/setup_workspace.sh"
fi

if [ -d "$ROOT_PATH/.dockflow" ]; then
	find "$ROOT_PATH/.dockflow" -type f -exec sed -i 's/\r$//' {} \; 2>/dev/null || true
fi

cd "$DOCKFLOW_PATH"
exec "$@"
