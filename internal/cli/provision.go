package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/Shawiizz/dockflow/internal/agent"
	"github.com/Shawiizz/dockflow/internal/connection"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/provision"
	"github.com/Shawiizz/dockflow/internal/version"
)

var fingerprintIn = regexp.MustCompile(`SHA256:[A-Za-z0-9+/=]+`)

// provisionFlags are the options of `server init <admin>@<host>`.
type provisionFlags struct {
	key, passwordFile, hostKey, name string
	user, deployKey                  string
	skipDocker, noFilter             bool
	// on the server itself: the address and SSH port the connection string gives
	host string
	port int
}

// provisionServer prepares a server from an administrator's account (ADR-0013): Docker, the
// deploy user and its key, then the switch and the registry as that user. It prints the
// connection string, which holds the deploy key: the key is generated here and never stored on
// the server.
func (a *app) provisionServer(ctx context.Context, target string, f provisionFlags, init func(*agent.Request)) error {
	admin, err := parseTarget(target, "root")
	if err != nil {
		return err
	}
	admin.Server.HostKey, admin.Server.Name = f.hostKey, f.name
	srv := admin.Server
	if f.key != "" {
		b, err := os.ReadFile(f.key)
		if err != nil {
			return errs.Usage("cannot read the key %s: %v", f.key, err)
		}
		admin.PrivateKey = string(b)
	}
	if f.passwordFile != "" {
		b, err := os.ReadFile(f.passwordFile)
		if err != nil {
			return errs.Usage("cannot read the password file %s: %v", f.passwordFile, err)
		}
		admin.Password = strings.TrimRight(string(b), "\r\n")
	}
	key, err := f.deployKeyFor(srv.Host)
	if err != nil {
		return err
	}
	a.emitter.Masker().Add(admin.PrivateKey, admin.Password, key.PrivatePEM)
	script, err := provision.Script(provision.Options{User: f.user, AuthorizedKey: key.Authorized, InstallDocker: !f.skipDocker, PortFilter: !f.noFilter})
	if err != nil {
		return err
	}
	a.emitter.Info(events.Log, fmt.Sprintf("connecting to %s as %s", admin.Addr(), srv.User), map[string]any{"line": "connect " + admin.Addr()})
	c, err := connection.Dial(ctx, admin)
	if err != nil {
		if e, ok := errs.As(err); ok && e.Code == "ssh.host_key_unknown" {
			fp := fingerprintIn.FindString(e.Message)
			e.Hint = fmt.Sprintf("check that the server shows %s with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, then run again with --host-key %s", fp, fp)
		}
		return err
	}
	command := "sh -s"
	if srv.User != "root" {
		// a sudo user: without a terminal, sudo must not ask for a password
		command = "sudo -n sh -s"
	}
	err = a.runProvisioning(script, func(out io.Writer) (int, error) {
		return runScript(ctx, c, command, script, out)
	}, srv.User)
	c.Close()
	if err != nil {
		return err
	}
	public := connection.Server{Name: srv.Name, Host: srv.Host, Port: srv.Port, User: f.user, HostKey: admin.Verified}
	// from here on, everything goes through the deploy user, as deploys will
	return a.finishProvisioning(ctx, &connection.Target{Server: public, PrivateKey: key.PrivatePEM}, public, key, init)
}

// deployKeyFor returns the deploy key: --deploy-key, or a new one.
func (f *provisionFlags) deployKeyFor(host string) (*provision.Key, error) {
	if f.user == "" {
		f.user = provision.DefaultUser
	}
	comment := f.user + "@" + host
	if f.deployKey == "" {
		return provision.NewKey(comment)
	}
	b, err := os.ReadFile(f.deployKey)
	if err != nil {
		return nil, errs.Usage("cannot read the deploy key %s: %v", f.deployKey, err)
	}
	return provision.KeyFrom(string(b), comment)
}

// runProvisioning runs the provisioning script through run, showing its steps.
func (a *app) runProvisioning(script string, run func(out io.Writer) (int, error), user string) error {
	pr, pw := io.Pipe()
	var output strings.Builder
	done := make(chan struct{})
	go func() {
		defer close(done)
		sc := bufio.NewScanner(pr)
		for sc.Scan() {
			line := sc.Text()
			output.WriteString(line + "\n")
			if step, ok := strings.CutPrefix(line, "step: "); ok {
				a.emitter.Info(events.Log, step, map[string]any{"line": step})
			} else {
				a.emitter.Debug(events.Log, line, map[string]any{"line": line})
			}
		}
	}()
	code, err := run(pw)
	pw.Close()
	<-done
	if err != nil {
		return errs.Connect("provisioning failed").WithCause(err)
	}
	if code != 0 {
		if user != "root" && strings.Contains(output.String(), "sudo") {
			return errs.Newf("provision.sudo", errs.ExitConnect, "%s cannot use sudo without a password", user).
				WithHint("connect as root, or give %s passwordless sudo for the time of server init", user)
		}
		return provision.Failed(code, output.String())
	}
	return nil
}

// finishProvisioning connects as the deploy user through connect, installs the switch and the
// registry, and prints the connection string of public: the server as the CI reaches it.
func (a *app) finishProvisioning(ctx context.Context, connect *connection.Target, public connection.Server, key *provision.Key, init func(*agent.Request)) error {
	if public.Name == "" {
		public.Name = "main"
	}
	connect.Server.Name = public.Name
	a.emitter.Info(events.Log, fmt.Sprintf("connecting as %s with the deploy key", public.User), map[string]any{"line": "connect " + public.User})
	s, err := a.dial(ctx, connect)
	if err != nil {
		return err
	}
	defer s.Close()
	req := agent.Request{
		Op: agent.OpServerInit, Run: s.run, Server: public.Name, Author: author(), DockflowVersion: version.Version,
	}
	init(&req)
	req.SSHPort = public.Port
	if _, err := s.runAgent(ctx, req); err != nil {
		return err
	}
	cs := connection.ConnString{Servers: []connection.Server{public}, PrivateKey: key.PrivatePEM}.Encode()
	if a.json {
		return json.NewEncoder(a.stdout).Encode(map[string]any{"connection": cs, "host": public.Host, "port": public.Port, "host_key": public.HostKey, "user": public.User})
	}
	fmt.Fprintf(a.stdout, "✓ %s is ready (edge: %s, deploy user: %s)\n\n", net.JoinHostPort(public.Host, strconv.Itoa(public.Port)), edgeName(req.Edge), public.User)
	fmt.Fprintf(a.stdout, "The connection string below holds the deploy key: store it as the <ENV>_CONNECTION secret\n")
	fmt.Fprintf(a.stdout, "(PRODUCTION_CONNECTION, ...) of your CI, or in .env.dockflow, and nowhere else. The key exists\n")
	fmt.Fprintf(a.stdout, "only there: if you lose it, run server init again, which installs a new one.\n\n%s\n", cs)
	return nil
}
