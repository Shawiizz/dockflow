package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"golang.org/x/crypto/ssh"

	"github.com/Shawiizz/dockflow/internal/agent"
	"github.com/Shawiizz/dockflow/internal/config"
	"github.com/Shawiizz/dockflow/internal/connection"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/provision"
)

// sshDir is where the SSH server's configuration and host keys are.
var sshDir = "/etc/ssh"

// provisionHere prepares the server this command runs on, as root (ADR-0013): the same script as
// over SSH, run locally. The address, the SSH port and the host key are read here, so nothing has
// to be typed; the deploy user is then checked through the SSH server, as the CI will reach it.
func (a *app) provisionHere(ctx context.Context, f provisionFlags, init func(*agent.Request)) error {
	if f.key != "" || f.passwordFile != "" || f.hostKey != "" {
		return errs.Usage("--key, --password-file and --host-key are for server init <admin>@<host>, from another machine")
	}
	if runtime.GOOS != "linux" {
		return errs.Usage("server init without an argument prepares the server it runs on, which must be Linux").
			WithHint("from this machine, prepare the server with: dockflow server init root@<host>")
	}
	if os.Geteuid() != 0 {
		return errs.Usage("server init without an argument prepares this server, and must run as root").
			WithHint("run it with sudo: sudo dockflow server init")
	}
	host, err := publicHost(f.host)
	if err != nil {
		return err
	}
	port := f.port
	if port == 0 {
		port = sshPort(filepath.Join(sshDir, "sshd_config"))
	}
	hostKey, err := hostKeyFingerprint()
	if err != nil {
		return err
	}
	key, err := f.deployKeyFor(host)
	if err != nil {
		return err
	}
	a.emitter.Masker().Add(key.PrivatePEM)
	script, err := provision.Script(provision.Options{User: f.user, AuthorizedKey: key.Authorized, InstallDocker: !f.skipDocker})
	if err != nil {
		return err
	}
	a.emitter.Info(events.Log, fmt.Sprintf("preparing this server (%s, SSH port %d)", host, port), map[string]any{"line": "local " + host})
	err = a.runProvisioning(script, func(out io.Writer) (int, error) {
		cmd := exec.CommandContext(ctx, "sh", "-s")
		cmd.Stdin, cmd.Stdout, cmd.Stderr = strings.NewReader(script), out, out
		err := cmd.Run()
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return exit.ExitCode(), nil
		}
		return 0, err
	}, "root")
	if err != nil {
		return err
	}
	public := connection.Server{Name: f.name, Host: host, Port: port, User: f.user, HostKey: hostKey}
	// through the SSH server on this machine: the deploy key and the host key are checked as
	// the CI will check them
	local := public
	local.Host = "127.0.0.1"
	return a.finishProvisioning(ctx, &connection.Target{Server: local, PrivateKey: key.PrivatePEM}, public, key, init)
}

// inProject reports whether dir holds a dockflow.yml.
func inProject(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, config.FileName))
	return err == nil
}

// publicHost is the address the CI reaches this server at: flag, or the address of the interface
// that routes to the internet, which must be public.
func publicHost(flag string) (string, error) {
	if flag != "" {
		return flag, nil
	}
	// no packet is sent: connecting a UDP socket only picks the route and the source address
	c, err := net.Dial("udp", "1.1.1.1:53")
	if err != nil {
		return "", errs.Usage("cannot find this server's address: %v", err).
			WithHint("give the address the CI reaches it at with --host")
	}
	defer c.Close()
	addr := c.LocalAddr().(*net.UDPAddr).AddrPort().Addr().Unmap()
	if addr.IsPrivate() || addr.IsLoopback() || addr.IsLinkLocalUnicast() || netip.MustParsePrefix("100.64.0.0/10").Contains(addr) {
		return "", errs.Usage("this server's address is %s, a private address: the CI probably reaches it at another one", addr).
			WithHint("give the public address or the domain name of this server with --host")
	}
	return addr.String(), nil
}

// sshPort is the first Port of the SSH server's configuration, following its Include lines; 22
// when there is none.
func sshPort(file string) int {
	f, err := os.Open(file)
	if err != nil {
		return 22
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 || strings.HasPrefix(fields[0], "#") {
			continue
		}
		switch strings.ToLower(fields[0]) {
		case "port":
			if p, err := strconv.Atoi(fields[1]); err == nil && p > 0 && p < 65536 {
				return p
			}
		case "include":
			for _, pattern := range fields[1:] {
				if !filepath.IsAbs(pattern) {
					pattern = filepath.Join(sshDir, pattern)
				}
				matches, _ := filepath.Glob(pattern)
				for _, m := range matches {
					if p := sshPort(m); p != 22 {
						return p
					}
				}
			}
		case "match":
			// Port cannot be set in a Match block, and nothing after it is global
			return 22
		}
	}
	return 22
}

// hostKeyFingerprint is the fingerprint of the SSH server's host key, ed25519 first, as the
// client asks for it.
func hostKeyFingerprint() (string, error) {
	for _, alg := range []string{"ed25519", "ecdsa", "rsa"} {
		b, err := os.ReadFile(filepath.Join(sshDir, "ssh_host_"+alg+"_key.pub"))
		if err != nil {
			continue
		}
		pub, _, _, _, err := ssh.ParseAuthorizedKey(b)
		if err != nil {
			continue
		}
		return ssh.FingerprintSHA256(pub), nil
	}
	return "", errs.Newf("provision.no_ssh_server", errs.ExitConnect, "no SSH host key in %s: is an SSH server installed?", sshDir).
		WithHint("install and start OpenSSH, then run server init again")
}
