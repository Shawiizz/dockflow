// Package provision prepares a server for Dockflow (ADR-0013): Docker, the deploy user and its
// key. Its script runs as root on the server, over SSH; every step is idempotent, so running it
// again on a prepared server changes nothing.
package provision

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"regexp"
	"strings"

	"golang.org/x/crypto/ssh"

	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/shell"
)

// DefaultUser is the deploy user.
const DefaultUser = "dockflow"

// KeyOptions restrict the deploy key to what Dockflow uses: commands, and forwarding to the
// Docker socket and the server's registry.
const KeyOptions = "restrict,port-forwarding,pty"

// Exit codes of the script, beyond a failed command.
const (
	exitNoDocker      = 20
	exitDockerTooOld  = 21
	exitUnsupportedOS = 22
	exitNoNginx       = 23
)

// MinDocker is the oldest Docker Engine Dockflow supports (ADR-0003).
const MinDocker = 27

var userName = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)

// Options are what to provision.
type Options struct {
	// User is the deploy user, created when missing and added to the docker group.
	User string
	// AuthorizedKey is the deploy key's authorized_keys line, added when missing.
	AuthorizedKey string
	// InstallDocker installs Docker from Docker's own repository when it is missing (Debian and
	// Ubuntu); otherwise a server without Docker is refused.
	InstallDocker bool
	// PortFilter installs the systemd unit that loads the published-port filter at boot, before
	// Docker (ADR-0014). The agent writes and applies the rules themselves.
	PortFilter bool
	// Harden adds the SSH hardening drop-in (ADR-0024). Admin is the account provisioning runs
	// from: SSH keeps accepting passwords while it has no key, so that it is not locked out.
	Harden bool
	Admin  string
	// Nginx installs nginx, which refuses the host names it does not serve, and the sudo rules
	// of the nginx plugin (ADR-0017).
	Nginx bool
}

// Script returns the provisioning script, to run as root with sh.
func Script(o Options) (string, error) {
	if !userName.MatchString(o.User) {
		return "", errs.Usage("%q is not a valid user name", o.User)
	}
	if strings.ContainsAny(o.AuthorizedKey, "\n\r") || o.AuthorizedKey == "" {
		return "", errs.Internal("the deploy key is not one authorized_keys line")
	}
	flag := func(b bool) string {
		if b {
			return "1"
		}
		return "0"
	}
	if o.Admin == "" {
		o.Admin = "root"
	}
	if !userName.MatchString(o.Admin) {
		return "", errs.Usage("%q is not a valid user name", o.Admin)
	}
	// the key's own part, by which a line with other options is replaced
	blob := ""
	fields := strings.Fields(o.AuthorizedKey)
	for i, f := range fields {
		if (strings.HasPrefix(f, "ssh-") || strings.HasPrefix(f, "ecdsa-")) && i+1 < len(fields) {
			blob = fields[i+1]
			break
		}
	}
	if blob == "" {
		return "", errs.Internal("the deploy key has no public key")
	}
	s := &shell.Script{}
	s.Set("DF_USER", o.User).Set("DF_KEY", o.AuthorizedKey).Set("DF_KEY_BLOB", blob).Set("DF_INSTALL_DOCKER", flag(o.InstallDocker)).
		Set("DF_PORT_FILTER", flag(o.PortFilter)).Set("DF_HARDEN", flag(o.Harden)).Set("DF_ADMIN", o.Admin).Set("DF_NGINX", flag(o.Nginx))
	s.Body(body)
	return s.String(), nil
}

// body is the script, after the assignments of DF_USER, DF_KEY and DF_INSTALL_DOCKER. It prints
// one "step: …" line per change it makes.
const body = `
say() { printf 'step: %s\n' "$1"; }

if ! command -v docker >/dev/null 2>&1; then
	[ "$DF_INSTALL_DOCKER" = 1 ] || exit 20
	. /etc/os-release
	case "$ID" in debian|ubuntu) ;; *) exit 22 ;; esac
	say "installing Docker from download.docker.com ($ID $VERSION_CODENAME)"
	export DEBIAN_FRONTEND=noninteractive
	apt-get update -q >/dev/null
	apt-get install -yq ca-certificates curl >/dev/null
	install -m 0755 -d /etc/apt/keyrings
	curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
	chmod a+r /etc/apt/keyrings/docker.asc
	printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
		"$(dpkg --print-architecture)" "$ID" "$VERSION_CODENAME" >/etc/apt/sources.list.d/docker.list
	apt-get update -q >/dev/null
	apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin >/dev/null
	if [ ! -e /etc/docker/daemon.json ]; then
		# a fresh Docker: rotate container logs before anything runs
		mkdir -p /etc/docker
		printf '{\n  "log-driver": "json-file",\n  "log-opts": { "max-size": "10m", "max-file": "3" }\n}\n' >/etc/docker/daemon.json
	fi
	if command -v systemctl >/dev/null 2>&1; then
		systemctl enable docker >/dev/null 2>&1 || true
		systemctl restart docker
	fi
fi

version=$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)
major=${version%%.*}
case "$major" in ''|*[!0-9]*) major=0 ;; esac
if [ "$major" -lt 27 ]; then
	printf 'docker: %s\n' "${version:-not running}" >&2
	exit 21
fi

if ! grep -q '^docker:' /etc/group; then
	say "creating the docker group"
	groupadd docker 2>/dev/null || addgroup docker
fi

if ! id -u "$DF_USER" >/dev/null 2>&1; then
	say "creating the user $DF_USER"
	useradd -m -s /bin/sh "$DF_USER" 2>/dev/null || adduser -D -s /bin/sh "$DF_USER"
fi
if ! id -nG "$DF_USER" | tr ' ' '\n' | grep -qx docker; then
	say "adding $DF_USER to the docker group"
	usermod -aG docker "$DF_USER" 2>/dev/null || addgroup "$DF_USER" docker
fi

home=$(awk -F: -v u="$DF_USER" '$1 == u { print $6 }' /etc/passwd)
[ -n "$home" ] || home="/home/$DF_USER"
mkdir -p "$home/.ssh"
touch "$home/.ssh/authorized_keys"
if ! grep -qxF "$DF_KEY" "$home/.ssh/authorized_keys"; then
	say "installing the deploy key of $DF_USER"
	# the same key with other options (from=) is replaced
	grep -vF "$DF_KEY_BLOB" "$home/.ssh/authorized_keys" >"$home/.ssh/authorized_keys.tmp" || true
	printf '%s\n' "$DF_KEY" >>"$home/.ssh/authorized_keys.tmp"
	mv "$home/.ssh/authorized_keys.tmp" "$home/.ssh/authorized_keys"
fi
mkdir -p /var/lib/dockflow
chmod 700 /var/lib/dockflow
chmod 700 "$home/.ssh"
chmod 600 "$home/.ssh/authorized_keys"
chown -R "$DF_USER:$(id -g "$DF_USER")" "$home/.ssh"

if [ "$DF_PORT_FILTER" = 1 ] && command -v systemctl >/dev/null 2>&1 && [ -d /etc/systemd/system ]; then
	# the rules the agent last applied, loaded again at boot before Docker publishes anything
	unit=/etc/systemd/system/dockflow-filter.service
	cat >"$unit.tmp" <<'UNIT'
[Unit]
Description=Dockflow published-port filter
Before=docker.service
After=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'for f in 4 6; do t=iptables; r=/etc/dockflow/filter.rules; [ $f = 6 ] && t=ip6tables && r=/etc/dockflow/filter6.rules; [ -f $r ] && command -v $t >/dev/null || continue; $t -w -n -L DOCKER-USER >/dev/null 2>&1 || $t -w -N DOCKER-USER; $t -w -n -L DOCKFLOW-FILTER >/dev/null 2>&1 || $t -w -N DOCKFLOW-FILTER; $t -w -n -L DOCKFLOW-INPUT >/dev/null 2>&1 || $t -w -N DOCKFLOW-INPUT; $t-restore -w --noflush <$r; $t -w -C DOCKER-USER -j DOCKFLOW-FILTER 2>/dev/null || $t -w -I DOCKER-USER -j DOCKFLOW-FILTER; $t -w -C INPUT -j DOCKFLOW-INPUT 2>/dev/null || $t -w -I INPUT -j DOCKFLOW-INPUT; done'

[Install]
WantedBy=multi-user.target
UNIT
	if ! cmp -s "$unit.tmp" "$unit"; then
		say "installing the port filter's boot unit"
		mv "$unit.tmp" "$unit"
		systemctl daemon-reload
		systemctl enable dockflow-filter.service >/dev/null 2>&1 || true
	else
		rm -f "$unit.tmp"
	fi
fi

# install_file replaces $2 with the file $1 when they differ, and says $3
install_file() {
	if cmp -s "$1" "$2"; then
		rm -f "$1"
		return 1
	fi
	mv "$1" "$2"
	[ -z "${3:-}" ] || say "$3"
	return 0
}

if [ "$DF_HARDEN" = 1 ]; then
	# SSH: keys only, root by key only; passwords stay while the admin account has no key
	if [ -d /etc/ssh/sshd_config.d ] && grep -qiE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d' /etc/ssh/sshd_config 2>/dev/null; then
		admin_home=$(awk -F: -v u="$DF_ADMIN" '$1 == u { print $6 }' /etc/passwd)
		dropin=/etc/ssh/sshd_config.d/50-dockflow.conf
		if [ -n "$admin_home" ] && grep -qE '^[^#]*(ssh-|ecdsa-)' "$admin_home/.ssh/authorized_keys" 2>/dev/null; then
			printf '# Written by Dockflow (server init): keys only, root by key only\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' >"$dropin.tmp"
		else
			printf '# Written by Dockflow (server init): root by key only; passwords stay until %s has a key\nPermitRootLogin prohibit-password\n' "$DF_ADMIN" >"$dropin.tmp"
		fi
		if install_file "$dropin.tmp" "$dropin" "hardening SSH ($dropin)"; then
			if sshd -t >/dev/null 2>&1; then
				systemctl reload ssh >/dev/null 2>&1 || systemctl reload sshd >/dev/null 2>&1 || true
			else
				rm -f "$dropin"
				say "SSH hardening undone: sshd refuses it"
			fi
			grep -q PasswordAuthentication "$dropin" 2>/dev/null || say "SSH still accepts passwords: $DF_ADMIN has no authorized key yet"
		fi
	fi
fi

if [ "$DF_NGINX" = 1 ]; then
	if ! command -v nginx >/dev/null 2>&1; then
		command -v apt-get >/dev/null 2>&1 || exit 23
		say "installing nginx"
		export DEBIAN_FRONTEND=noninteractive
		apt-get update -q >/dev/null
		apt-get install -yq nginx >/dev/null
	fi
	# host names no vhost serves are refused, rather than served by the first vhost
	if [ -L /etc/nginx/sites-enabled/default ]; then
		rm -f /etc/nginx/sites-enabled/default
	fi
	mkdir -p /etc/nginx/conf.d
	v6=""
	if [ -e /proc/net/if_inet6 ]; then v6=1; fi
	{
		printf '# Written by Dockflow (server init --nginx): host names no vhost serves are refused\n'
		printf 'server {\n    listen 80 default_server;\n'
		if [ -n "$v6" ]; then printf '    listen [::]:80 default_server;\n'; fi
		printf '    server_name _;\n    return 444;\n}\n'
		printf 'server {\n    listen 443 ssl default_server;\n'
		if [ -n "$v6" ]; then printf '    listen [::]:443 ssl default_server;\n'; fi
		printf '    server_name _;\n    ssl_reject_handshake on;\n}\n'
	} >/etc/nginx/conf.d/00-dockflow-default.conf.tmp
	if install_file /etc/nginx/conf.d/00-dockflow-default.conf.tmp /etc/nginx/conf.d/00-dockflow-default.conf "refusing unknown host names in nginx"; then
		if nginx -t >/dev/null 2>&1; then
			systemctl reload nginx >/dev/null 2>&1 || systemctl enable --now nginx >/dev/null 2>&1 || true
		fi
	fi
	# the nginx plugin checks and reloads nginx as the deploy user
	if command -v visudo >/dev/null 2>&1; then
		mkdir -p /etc/sudoers.d
		printf '# Written by Dockflow (server init --nginx): what the nginx plugin runs\n%s ALL=(root) NOPASSWD: %s -t, %s reload nginx\n' \
			"$DF_USER" "$(command -v nginx)" "$(command -v systemctl || echo /usr/bin/systemctl)" >/etc/sudoers.d/dockflow-nginx.tmp
		chmod 440 /etc/sudoers.d/dockflow-nginx.tmp
		if visudo -cqf /etc/sudoers.d/dockflow-nginx.tmp >/dev/null 2>&1; then
			install_file /etc/sudoers.d/dockflow-nginx.tmp /etc/sudoers.d/dockflow-nginx "allowing $DF_USER to check and reload nginx" || true
		else
			rm -f /etc/sudoers.d/dockflow-nginx.tmp
		fi
	fi
fi

# Cloudflare's ranges, downloaded again every week for the cloudflare edge (ADR-0014)
mkdir -p /usr/local/libexec
cat >/usr/local/libexec/dockflow-cloudflare-refresh.tmp <<'SCRIPT'
` + CloudflareRefresh + `SCRIPT
chmod 755 /usr/local/libexec/dockflow-cloudflare-refresh.tmp
if ! cmp -s /usr/local/libexec/dockflow-cloudflare-refresh.tmp /usr/local/libexec/dockflow-cloudflare-refresh; then
	mv /usr/local/libexec/dockflow-cloudflare-refresh.tmp /usr/local/libexec/dockflow-cloudflare-refresh
else
	rm -f /usr/local/libexec/dockflow-cloudflare-refresh.tmp
fi
if command -v systemctl >/dev/null 2>&1 && [ -d /etc/systemd/system ]; then
	cat >/etc/systemd/system/dockflow-cloudflare.service.tmp <<'UNIT'
[Unit]
Description=Dockflow: download Cloudflare's ranges for the cloudflare edge
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/libexec/dockflow-cloudflare-refresh
UNIT
	cat >/etc/systemd/system/dockflow-cloudflare.timer.tmp <<'UNIT'
[Unit]
Description=Dockflow: download Cloudflare's ranges every week

[Timer]
OnCalendar=weekly
RandomizedDelaySec=6h
Persistent=true

[Install]
WantedBy=timers.target
UNIT
	changed=0
	for u in dockflow-cloudflare.service dockflow-cloudflare.timer; do
		if ! cmp -s "/etc/systemd/system/$u.tmp" "/etc/systemd/system/$u"; then
			mv "/etc/systemd/system/$u.tmp" "/etc/systemd/system/$u"
			changed=1
		else
			rm -f "/etc/systemd/system/$u.tmp"
		fi
	done
	if [ "$changed" = 1 ]; then
		say "installing the weekly download of Cloudflare's ranges"
		systemctl daemon-reload
		systemctl enable --now dockflow-cloudflare.timer >/dev/null 2>&1 || true
	fi
fi

printf 'docker: %s\n' "$version"
`

// CloudflareRefresh is the script the weekly timer runs: with the cloudflare edge, it runs the
// newest Dockflow agent of the server to download Cloudflare's ranges, which keeps the previous
// ones when the download fails, and applies them to the switch and the port filter.
const CloudflareRefresh = `#!/bin/sh
set -e
grep -q '"edge": "cloudflare"' /var/lib/dockflow/server.json 2>/dev/null || exit 0
image=$(docker images dockflow/agent --format '{{.Repository}}:{{.Tag}}' | head -n 1)
if [ -z "$image" ]; then
	echo "no Dockflow agent image on this server yet: the next deploy brings one" >&2
	exit 0
fi
run="cloudflare-$(date +%s)"
printf '{"op":"server.cloudflare.refresh","run":"%s","server":"main"}\n' "$run" |
	docker run --rm -i --name "dockflow-run-$run" --label dockflow.kind=run --label dockflow.managed=true \
		-v /var/run/docker.sock:/var/run/docker.sock -v /var/lib/dockflow:/var/lib/dockflow \
		-v /run/dockflow:/run/dockflow -v dockflow-switch-admin:/run/dockflow-switch "$image"
`

// Failed turns the script's exit code into an error.
func Failed(code int, output string) error {
	switch code {
	case exitNoDocker:
		return errs.Newf("provision.no_docker", errs.ExitConnect, "Docker is not installed on the server").
			WithHint("install Docker %d or later, or drop --skip-docker-install", MinDocker)
	case exitDockerTooOld:
		return errs.Newf("provision.docker_too_old", errs.ExitConnect, "the server's Docker is older than %d, or not running (%s)", MinDocker, strings.TrimSpace(lastLine(output))).
			WithHint("upgrade Docker Engine to %d or later and start it", MinDocker)
	case exitNoNginx:
		return errs.Newf("provision.no_nginx", errs.ExitConnect, "--nginx: nginx is not installed, and Dockflow installs it on Debian and Ubuntu only").
			WithHint("install nginx yourself, then run server init again")
	case exitUnsupportedOS:
		return errs.Newf("provision.unsupported_os", errs.ExitConnect, "Docker is not installed, and Dockflow installs it on Debian and Ubuntu only").
			WithHint("install Docker %d or later yourself, then run server init again", MinDocker)
	}
	return errs.Newf("provision.failed", errs.ExitConnect, "provisioning failed (exit code %d): %s", code, strings.TrimSpace(lastLine(output))).
		WithHint("the output above says which step failed; every step can be run again safely")
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return lines[len(lines)-1]
}

// Key is a deploy key generated on this machine (ADR-0013: never on the server).
type Key struct {
	// PrivatePEM is the private key in OpenSSH format.
	PrivatePEM string
	// Authorized is the authorized_keys line, with KeyOptions.
	Authorized string
}

// NewKey generates an ed25519 deploy key.
func NewKey(comment string) (*Key, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, errs.Internal("generate a key: %v", err)
	}
	block, err := ssh.MarshalPrivateKey(priv, comment)
	if err != nil {
		return nil, errs.Internal("encode the key: %v", err)
	}
	sp, err := ssh.NewPublicKey(pub)
	if err != nil {
		return nil, errs.Internal("encode the key: %v", err)
	}
	return &Key{PrivatePEM: string(pem.EncodeToMemory(block)), Authorized: AuthorizedLine(sp, comment)}, nil
}

// KeyFrom reads a deploy key from an OpenSSH or PEM private key.
func KeyFrom(privatePEM, comment string) (*Key, error) {
	signer, err := ssh.ParsePrivateKey([]byte(privatePEM))
	if err != nil {
		return nil, errs.Usage("the deploy key cannot be read: %v", err).
			WithHint("give a private key without passphrase, or let server init generate one")
	}
	return &Key{PrivatePEM: privatePEM, Authorized: AuthorizedLine(signer.PublicKey(), comment)}, nil
}

// Restrict limits the key to the source addresses from, with the from= option of
// authorized_keys (ADR-0013).
func (k *Key) Restrict(from []string) error {
	if len(from) == 0 {
		return nil
	}
	for _, f := range from {
		if !sourcePattern.MatchString(f) {
			return errs.Usage("--from %q is not an address, a CIDR or a host pattern", f)
		}
	}
	k.Authorized = `from="` + strings.Join(from, ",") + `",` + k.Authorized
	return nil
}

// sourcePattern is what from= takes: addresses, CIDRs, host name patterns.
var sourcePattern = regexp.MustCompile(`^!?[A-Za-z0-9.:/*?_-]+$`)

// AuthorizedLine is the authorized_keys line of pub, restricted with KeyOptions.
func AuthorizedLine(pub ssh.PublicKey, comment string) string {
	line := KeyOptions + " " + strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pub)))
	if comment = strings.Join(strings.Fields(comment), "-"); comment != "" {
		line += " " + comment
	}
	return line
}
