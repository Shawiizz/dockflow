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
}

// Script returns the provisioning script, to run as root with sh.
func Script(o Options) (string, error) {
	if !userName.MatchString(o.User) {
		return "", errs.Usage("%q is not a valid user name", o.User)
	}
	if strings.ContainsAny(o.AuthorizedKey, "\n\r") || o.AuthorizedKey == "" {
		return "", errs.Internal("the deploy key is not one authorized_keys line")
	}
	install, portFilter := "0", "0"
	if o.InstallDocker {
		install = "1"
	}
	if o.PortFilter {
		portFilter = "1"
	}
	s := &shell.Script{}
	s.Set("DF_USER", o.User).Set("DF_KEY", o.AuthorizedKey).Set("DF_INSTALL_DOCKER", install).Set("DF_PORT_FILTER", portFilter)
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
	printf '%s\n' "$DF_KEY" >>"$home/.ssh/authorized_keys"
fi
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
ExecStart=/bin/sh -c 'for f in 4 6; do t=iptables; r=/etc/dockflow/filter.rules; [ $f = 6 ] && t=ip6tables && r=/etc/dockflow/filter6.rules; [ -f $r ] && command -v $t >/dev/null || continue; $t -w -n -L DOCKER-USER >/dev/null 2>&1 || $t -w -N DOCKER-USER; $t -w -n -L DOCKFLOW-FILTER >/dev/null 2>&1 || $t -w -N DOCKFLOW-FILTER; $t-restore -w --noflush <$r; $t -w -C DOCKER-USER -j DOCKFLOW-FILTER 2>/dev/null || $t -w -I DOCKER-USER -j DOCKFLOW-FILTER; done'

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

printf 'docker: %s\n' "$version"
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

// AuthorizedLine is the authorized_keys line of pub, restricted with KeyOptions.
func AuthorizedLine(pub ssh.PublicKey, comment string) string {
	line := KeyOptions + " " + strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pub)))
	if comment = strings.Join(strings.Fields(comment), "-"); comment != "" {
		line += " " + comment
	}
	return line
}
