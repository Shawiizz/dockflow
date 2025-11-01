#!/bin/bash
# Export environment variables to YAML and render all Docker files with Ansible
# Usage: export_vars_and_render_docker_files.sh

set -e

#######################################
### Export vars to YAML file ##########
#######################################
echo "Exporting environment variables to /tmp/ansible_env_vars.yml..."
python3 << 'PYTHON_EOF'
import os
import yaml

env_vars = {}
for key, value in os.environ.items():
    if key and key not in ['_', 'OLDPWD']:
        # Convert to lowercase for consistency
        key_lower = key.lower()
        env_vars[key_lower] = value

# Write as proper YAML with multiline support
with open('/tmp/ansible_env_vars.yml', 'w') as f:
    yaml.dump(env_vars, f, default_flow_style=False, allow_unicode=True)
PYTHON_EOF

echo "Environment variables exported to /tmp/ansible_env_vars.yml"

#######################################
### Render all files in docker folder #
#######################################
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLAYBOOK_PATH="$SCRIPT_DIR/../../ansible/playbooks/render_template.yml"
DOCKER_DIR=".deployment/docker"

if [ ! -d "$DOCKER_DIR" ]; then
    echo "No $DOCKER_DIR directory found, skipping rendering"
    exit 0
fi

echo "Rendering all files in $DOCKER_DIR..."
FILE_COUNT=0

while IFS= read -r file; do
    if [ -f "$file" ]; then
        echo "Rendering $file..."
        FILE_ABS_PATH="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"
        
        ansible-playbook "$PLAYBOOK_PATH" \
            -e "input_file=$FILE_ABS_PATH" \
            -e "output_file=$FILE_ABS_PATH" \
            --connection=local
        
        echo "✓ $file rendered successfully"
        FILE_COUNT=$((FILE_COUNT + 1))
    fi
done < <(find "$DOCKER_DIR" -type f 2>/dev/null)

if [ $FILE_COUNT -eq 0 ]; then
    echo "No files found in $DOCKER_DIR"
else
    echo ""
    echo "✓ Rendered $FILE_COUNT file(s) successfully"
fi
