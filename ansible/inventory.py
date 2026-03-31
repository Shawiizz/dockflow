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
SSH_KEY_FILE_BASE = '/tmp/dockflow_ssh_key'
SSH_COMMON_ARGS = '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'


def write_ssh_key(private_key: str, path: str) -> None:
    if not private_key:
        return
    normalized_key = private_key.replace('\\n', '\n').replace('\r\n', '\n').strip() + '\n'
    with open(path, 'w') as f:
        f.write(normalized_key)
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)


def build_hostvars(connection: dict, key_file: str) -> dict:
    hostvars = {
        "ansible_host": connection.get('host', ''),
        "ansible_port": connection.get('port', 22),
        "ansible_user": connection.get('user', 'root'),
        "ansible_ssh_private_key_file": key_file,
        "ansible_ssh_common_args": SSH_COMMON_ARGS,
    }
    password = connection.get('password', '')
    if password:
        hostvars["ansible_become_password"] = password
    return hostvars


def get_inventory():
    """Generate Ansible inventory from context file."""

    if not os.path.exists(CONTEXT_FILE):
        return {"_meta": {"hostvars": {}}}

    try:
        with open(CONTEXT_FILE, 'r') as f:
            ctx = json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        print(f"Error reading context file: {e}", file=sys.stderr)
        return {"_meta": {"hostvars": {}}}

    connection = ctx.get('ssh_connection', ctx.get('connection', {}))
    env = ctx.get('env', 'unknown')

    hostvars = {}

    # --- Manager ---
    manager_key_file = f"{SSH_KEY_FILE_BASE}_manager"
    write_ssh_key(connection.get('private_key', ''), manager_key_file)

    manager_host_name = f"{env}-{ctx.get('server_name', 'server')}"
    hostvars[manager_host_name] = build_hostvars(connection, manager_key_file)

    # --- Workers ---
    worker_host_names = []
    for i, worker in enumerate(ctx.get('workers', [])):
        worker_key_file = f"{SSH_KEY_FILE_BASE}_worker_{i}"
        write_ssh_key(worker.get('private_key', ''), worker_key_file)

        worker_host_name = f"{env}-{worker.get('name', f'worker-{i}')}"
        hostvars[worker_host_name] = build_hostvars(worker, worker_key_file)
        worker_host_names.append(worker_host_name)

    return {
        "all": {"children": ["managers", "workers"]},
        "managers": {"hosts": [manager_host_name]},
        "workers": {"hosts": worker_host_names},
        "_meta": {"hostvars": hostvars},
    }


def main():
    inventory = get_inventory()

    if len(sys.argv) == 3 and sys.argv[1] == '--host':
        host = sys.argv[2]
        print(json.dumps(inventory.get('_meta', {}).get('hostvars', {}).get(host, {}), indent=2))
    else:
        print(json.dumps(inventory, indent=2))


if __name__ == '__main__':
    main()
