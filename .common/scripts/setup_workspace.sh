#!/bin/bash
set -e

readonly SOURCE_DIR="/project"
readonly WORKSPACE_DIR="/workspace"

materialize_path() {
	local rel_path="$1"
	local merged="$WORKSPACE_DIR/merged"
	local dir_part file_part
	dir_part=$(dirname "$rel_path")
	file_part=$(basename "$rel_path")

	local current="$merged"
	local components
	IFS='/' read -ra components <<<"$dir_part"

	for component in "${components[@]}"; do
		[ -z "$component" ] && continue
		current="$current/$component"

		if [ -L "$current" ]; then
			local target
			target=$(readlink "$current")
			rm "$current"
			mkdir -p "$current"
			for item in "$target"/* "$target"/.[!.]*; do
				[ -e "$item" ] || continue
				ln -s "$item" "$current/$(basename "$item")" 2>/dev/null || true
			done
		fi
	done

	local file_full="$current/$file_part"
	local source_full="$SOURCE_DIR/$rel_path"

	if [ -e "$source_full" ]; then
		[ -L "$file_full" ] && rm "$file_full"
		cp -a "$source_full" "$file_full"
		echo "  Materialized: $rel_path"
	fi
}

extract_template_paths() {
	python3 <<'PYEOF'
import os

config_file = "/workspace/merged/.dockflow/config.yml"
if not os.path.exists(config_file):
    exit(0)

try:
    import yaml
    config = yaml.safe_load(open(config_file))
    for tmpl in (config or {}).get("templates", []) or []:
        if isinstance(tmpl, dict):
            paths = [tmpl.get("src", ""), tmpl.get("dest", tmpl.get("src", ""))]
        else:
            paths = [str(tmpl)]
        for path in paths:
            if path and "{{" not in path and not path.startswith(".dockflow"):
                print(path)
except Exception:
    pass
PYEOF
}

setup_workspace() {
	if [ -d "$WORKSPACE_DIR/merged/.dockflow" ]; then
		return 0
	fi

	echo "Setting up writable workspace..."
	mkdir -p "$WORKSPACE_DIR/merged"

	cp -a "$SOURCE_DIR/.dockflow" "$WORKSPACE_DIR/merged/.dockflow"

	for item in "$SOURCE_DIR"/* "$SOURCE_DIR"/.[!.]*; do
		[ -e "$item" ] || continue
		local name
		name=$(basename "$item")
		[ "$name" = ".dockflow" ] && continue
		ln -s "$item" "$WORKSPACE_DIR/merged/$name" 2>/dev/null || true
	done

	local template_paths
	template_paths=$(extract_template_paths 2>/dev/null) || true
	if [ -n "$template_paths" ]; then
		echo "$template_paths" | while IFS= read -r path; do
			[ -n "$path" ] && materialize_path "$path"
		done
	fi

	echo "  Workspace ready"
}

setup_workspace
export ROOT_PATH="$WORKSPACE_DIR/merged"
