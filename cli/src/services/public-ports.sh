#!/usr/bin/env bash
# dockflow-public-ports: lets the internet reach only the published container ports that
# Dockflow projects declare public (firewall.public_ports, plus Traefik's ports).
#
# Docker publishes a port with a DNAT rule that ufw and firewalld never see, and evaluates the
# DOCKER-USER chain before its own rules. This script keeps a chain of its own at the top of
# DOCKER-USER: a connection that reaches a published port from the internet (an interface of a
# default route) goes on only when a project declared that port, from that address.
# Installed by `dockflow setup`; runs as root.
#
#   set <project> [<port>[-<port>]/<tcp|udp>[@<cidr>[,<cidr>]...]]...
#              record the public ports of a project (none: forget it), then apply; exits 3
#              when Docker does not send published ports through DOCKER-USER
#   apply      load the filter for every project (at boot, before Docker starts)
#   status     print the recorded ports and the rules in place
#   render 4|6 print the rules apply loads into iptables or ip6tables, without loading them
#   off        remove the filter; the recorded ports stay
set -uo pipefail

# overridable for tests only: sudo resets the environment
STATE_DIR="${DOCKFLOW_PUBLIC_PORTS_DIR:-/etc/dockflow/public-ports}"
CHAIN=DOCKFLOW-PUBLIC-PORTS

die() {
	echo "dockflow-public-ports: $*" >&2
	exit 1
}

valid_project() {
	[[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]
}

# <port>[-<port>]/<tcp|udp>[@<cidr>,...] with ports in 1-65535, the first not after the last
valid_spec() {
	[[ $1 =~ ^([0-9]{1,5})(-([0-9]{1,5}))?/(tcp|udp)(@[0-9A-Fa-f.:/]+(,[0-9A-Fa-f.:/]+)*)?$ ]] || return 1
	local first=${BASH_REMATCH[1]} last=${BASH_REMATCH[3]:-${BASH_REMATCH[1]}}
	((10#$first >= 1 && 10#$last <= 65535 && 10#$first <= 10#$last))
}

# every recorded port, once
specs() {
	local file
	for file in "$STATE_DIR"/*; do
		[ -f "$file" ] || continue
		valid_project "${file##*/}" || continue
		cat "$file"
	done | LC_ALL=C sort -u
}

# the interfaces of the default routes of IPv<family>: the way in from the internet
interfaces() {
	{
		if command -v ip >/dev/null 2>&1; then
			ip -"$1" route show default 2>/dev/null |
				awk '{ for (i = 1; i < NF; i++) if ($i == "dev") print $(i + 1) }'
		elif [ "$1" = 4 ]; then
			# without iproute2: the default route goes to 00000000, the interface comes first
			awk 'NR > 1 && $2 == "00000000" && $1 != "lo" { print $1 }' /proc/net/route 2>/dev/null
		else
			# ::/0, the interface comes last
			awk '$1 == "00000000000000000000000000000000" && $2 == "00" && $NF != "lo" { print $NF }' /proc/net/ipv6_route 2>/dev/null
		fi
	} | grep -E '^[A-Za-z0-9_.-]+$' | LC_ALL=C sort -u
}

# the chain for IPv<family>, as iptables-restore reads it: declaring the chain empties it, so
# the new rules replace the old ones at once
render() {
	local family=$1 iface spec ports rest proto range sources src
	echo '*filter'
	echo ":$CHAIN - [0:0]"
	echo "-A $CHAIN -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN"
	for iface in $(interfaces "$family"); do
		# line by line: a line that is not one valid port is skipped whole
		while IFS= read -r spec; do
			valid_spec "$spec" || continue
			ports=${spec%%/*}
			rest=${spec#*/}
			proto=${rest%%@*}
			range=${ports/-/:}
			if [[ $rest != *@* ]]; then
				echo "-A $CHAIN -i $iface -p $proto -m conntrack --ctstate DNAT --ctorigdstport $range --ctdir ORIGINAL -j RETURN"
				continue
			fi
			sources=${rest#*@}
			for src in ${sources//,/ }; do
				# an address belongs to the table of its family
				if [[ $src == *:* ]]; then
					[ "$family" = 6 ] || continue
				else
					[ "$family" = 4 ] || continue
				fi
				echo "-A $CHAIN -i $iface -s $src -p $proto -m conntrack --ctstate DNAT --ctorigdstport $range --ctdir ORIGINAL -j RETURN"
			done
		done < <(specs)
		# published ports are destination-NATed: other traffic of the interface is left alone
		echo "-A $CHAIN -i $iface -m conntrack --ctstate DNAT -j DROP"
	done
	echo 'COMMIT'
}

# load the chain of one family and jump to it from the top of DOCKER-USER
apply_family() {
	local family=$1 ipt=iptables
	[ "$family" = 6 ] && ipt=ip6tables
	command -v "$ipt" >/dev/null 2>&1 || return 0
	# Docker creates DOCKER-USER only when missing and never empties it: created before Docker
	# starts, it is the one Docker uses
	if ! "$ipt" -w -n -L DOCKER-USER >/dev/null 2>&1 && ! "$ipt" -w -N DOCKER-USER 2>/dev/null; then
		# a kernel without IPv6 filtering has nothing to protect there
		[ "$family" = 6 ] && return 0
		echo "dockflow-public-ports: cannot create the DOCKER-USER chain of $ipt" >&2
		return 1
	fi
	if [ "$family" = 4 ] && [ -z "$(interfaces 4)" ]; then
		echo "dockflow-public-ports: no IPv4 default route, so no interface to filter" >&2
	fi
	render "$family" | "$ipt-restore" -w --noflush || return 1
	"$ipt" -w -C DOCKER-USER -j "$CHAIN" 2>/dev/null || "$ipt" -w -I DOCKER-USER 1 -j "$CHAIN"
}

apply() {
	local status=0
	apply_family 4 || status=1
	apply_family 6 || status=1
	return $status
}

# Docker sends published ports through DOCKER-USER only with its iptables backend
effective() {
	iptables -w -C FORWARD -j DOCKER-USER 2>/dev/null
}

set_project() {
	local project=$1 spec
	shift
	valid_project "$project" || die "invalid project name: $project"
	for spec in "$@"; do
		valid_spec "$spec" || die "invalid public port: $spec"
	done
	mkdir -p "$STATE_DIR" || die "cannot create $STATE_DIR"
	if [ $# -eq 0 ]; then
		rm -f "$STATE_DIR/$project" || die "cannot forget the ports of $project"
	elif ! { printf '%s\n' "$@" >"$STATE_DIR/.$project.new" && mv -f "$STATE_DIR/.$project.new" "$STATE_DIR/$project"; }; then
		die "cannot record the ports of $project"
	fi
	apply || return 1
	if ! effective; then
		echo "dockflow-public-ports: Docker does not send published ports through DOCKER-USER here (iptables disabled, or its nftables backend): the ports are recorded, not filtered" >&2
		return 3
	fi
}

status() {
	local file found=
	echo "Public ports by project ($STATE_DIR):"
	for file in "$STATE_DIR"/*; do
		[ -f "$file" ] || continue
		found=1
		echo "  ${file##*/}: $(tr '\n' ' ' <"$file")"
	done
	[ -n "$found" ] || echo "  none"
	iptables -w -S "$CHAIN" 2>/dev/null || echo "The filter is not in place."
	effective || echo "Docker does not send published ports through DOCKER-USER: nothing is filtered."
}

off() {
	local ipt
	for ipt in iptables ip6tables; do
		command -v "$ipt" >/dev/null 2>&1 || continue
		while "$ipt" -w -D DOCKER-USER -j "$CHAIN" 2>/dev/null; do :; done
		"$ipt" -w -F "$CHAIN" 2>/dev/null
		"$ipt" -w -X "$CHAIN" 2>/dev/null
	done
	return 0
}

case "${1:-}" in
set)
	shift
	[ $# -ge 1 ] || die "usage: set <project> [<port>[-<port>]/<tcp|udp>[@<cidr>,...]]..."
	set_project "$@"
	;;
apply) apply ;;
status) status ;;
render)
	[[ ${2:-} =~ ^[46]$ ]] || die "usage: render 4|6"
	render "$2"
	;;
off) off ;;
*) die "usage: dockflow-public-ports set|apply|status|render|off (see the top of $0)" ;;
esac
