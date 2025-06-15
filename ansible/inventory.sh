#!/bin/bash

cat <<EOF
all:
  hosts:
    ${ENV}:
      ansible_host: ${REMOTE_IP}
      ansible_user: ${ANSIBLE_USER}
      ansible_ssh_private_key_file: devops/ssh/remote_private_key
EOF
