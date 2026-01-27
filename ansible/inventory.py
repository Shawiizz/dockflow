#!/usr/bin/env python3
"""
Dynamic Ansible inventory that reads from /tmp/dockflow_context.json

This inventory script generates host configuration from the JSON context
file mounted by the CLI, eliminating the need for shell variable exports.

Usage: ansible-playbook deploy.yml -i inventory.py
"""

import json
import sys
import os
import stat

CONTEXT_FILE = '/tmp/dockflow_context.json'
SSH_KEY_FILE = '/tmp/dockflow_key'


def write_ssh_key(private_key: str) -> str:
    """
    Write SSH private key from context to a file.
    Returns the path to the key file.
    """
    # Normalize line endings and ensure trailing newline
    normalized_key = private_key.replace('\\n', '\n').replace('\r\n', '\n').strip() + '\n'
    
    # Write with restricted permissions (600)
    with open(SSH_KEY_FILE, 'w') as f:
        f.write(normalized_key)
    os.chmod(SSH_KEY_FILE, stat.S_IRUSR | stat.S_IWUSR)
    
    return SSH_KEY_FILE


def get_inventory():
    """Generate Ansible inventory from context file."""
    
    # Check if context file exists
    if not os.path.exists(CONTEXT_FILE):
        # Return empty inventory if no context (for ansible --list)
        return {"_meta": {"hostvars": {}}}
    
    try:
        with open(CONTEXT_FILE, 'r') as f:
            ctx = json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        print(f"Error reading context file: {e}", file=sys.stderr)
        return {"_meta": {"hostvars": {}}}
    
    # Extract SSH connection info (named ssh_connection to avoid Ansible reserved name)
    connection = ctx.get('ssh_connection', ctx.get('connection', {}))
    env = ctx.get('env', 'unknown')
    server_name = ctx.get('server_name', 'server')
    
    # Write SSH key from context to file (Ansible needs a file path)
    private_key = connection.get('private_key', '')
    if private_key:
        write_ssh_key(private_key)
    
    # Build host name (e.g., "production-main")
    host_name = f"{env}-{server_name}"
    
    # Build hostvars
    hostvars = {
        "ansible_host": connection.get('host', ''),
        "ansible_port": connection.get('port', 22),
        "ansible_user": connection.get('user', 'root'),
        "ansible_ssh_private_key_file": "/tmp/dockflow_key",
        "ansible_ssh_common_args": "-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
    }
    
    # Add become password if provided (for servers without NOPASSWD in sudoers)
    password = connection.get('password', '')
    if password:
        hostvars["ansible_become_password"] = password
    
    # Build inventory structure
    inventory = {
        "all": {
            "hosts": [host_name],
            "vars": {}
        },
        "_meta": {
            "hostvars": {
                host_name: hostvars
            }
        }
    }
    
    return inventory

def main():
    """Main entry point."""
    # Ansible calls with --list or --host <hostname>
    if len(sys.argv) == 2 and sys.argv[1] == '--list':
        print(json.dumps(get_inventory(), indent=2))
    elif len(sys.argv) == 3 and sys.argv[1] == '--host':
        # Return host vars for specific host
        inventory = get_inventory()
        host = sys.argv[2]
        hostvars = inventory.get('_meta', {}).get('hostvars', {}).get(host, {})
        print(json.dumps(hostvars, indent=2))
    else:
        # Default: return full inventory
        print(json.dumps(get_inventory(), indent=2))

if __name__ == '__main__':
    main()
