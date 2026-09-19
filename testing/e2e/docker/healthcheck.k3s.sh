#!/bin/sh
# Healthy once systemd finished booting (a failed unit is tolerated), sshd accepts connections
# and both registry forwarders run.
state=$(systemctl is-system-running 2>/dev/null || true)
case "$state" in
running | degraded) ;;
*) exit 1 ;;
esac
systemctl is-active --quiet ssh &&
	systemctl is-active --quiet e2e-forward@35010 &&
	systemctl is-active --quiet e2e-forward@35011
