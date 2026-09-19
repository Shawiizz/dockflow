#!/bin/sh
# k3s e2e node entrypoint: prepare what systemd and the kubelet need inside a container, then hand
# PID 1 to systemd. k3s itself is installed later by `dockflow setup k3s`.
set -eu

# kubelet volume mounts and local-path need shared propagation
mount --make-rshared /

# unique identity per container (systemd, k3s node password); host keys survive a restart
rm -f /etc/machine-id && systemd-machine-id-setup >/dev/null
[ -e /etc/ssh/ssh_host_ed25519_key ] || ssh-keygen -A >/dev/null

# kubelet OOM watcher reads /dev/kmsg
[ -e /dev/kmsg ] || ln -s /dev/console /dev/kmsg

# registry forwarders (e2e-forward@<port>.service): 127.0.0.1:<port> on the node -> lane registry
install -d /etc/e2e
printf 'TARGET=%s\n' "${E2E_REGISTRY_ADDR:?}" >/etc/e2e/forward-35010.env
printf 'TARGET=%s\n' "${E2E_REGISTRY_AUTH_ADDR:?}" >/etc/e2e/forward-35011.env

exec /sbin/init
