package cli

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/Shawiizz/dockflow/internal/connection"
	"github.com/Shawiizz/dockflow/internal/errs"
)

// connectionCmd prints the connection string of a server, once it has reached it: the host key it
// holds is the one SSH verified, against --host-key or known_hosts (ADR-0013).
func (a *app) connectionCmd() *cobra.Command {
	var key, hostKey, name, env string
	cmd := &cobra.Command{
		Use:   "connection [<user@host[:port]>]",
		Short: "Print the connection string of a server, for the <ENV>_CONNECTION secret",
		Long: "Connects to the server, verifying its host key against --host-key or known_hosts, checks that the user can " +
			"use Docker, and prints the connection string: the server, its host key and the private key. Without a " +
			"target, uses the server of --env, as a deploy would.",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			a.quiet()
			var t *connection.Target
			if len(args) == 1 {
				srv, err := parseTarget(args[0])
				if err != nil {
					return err
				}
				srv.HostKey, srv.Name = hostKey, name
				t = &connection.Target{Server: srv}
			} else {
				l, err := a.load(ctx, env, "")
				if err != nil {
					return err
				}
				if t, err = connection.Resolve(l.Config.Env, l.Config, l.Secrets.Lookup, a.connection, os.Getenv); err != nil {
					return err
				}
				if hostKey != "" {
					t.Server.HostKey = hostKey
				}
			}
			if key == "" && t.PrivateKey == "" && t.Password == "" {
				key = os.Getenv("DOCKFLOW_SSH_KEY")
			}
			if key != "" {
				b, err := os.ReadFile(key)
				switch {
				case err == nil:
					t.PrivateKey = string(b)
				case strings.Contains(key, "PRIVATE KEY"):
					t.PrivateKey = key
				default:
					return errs.Usage("cannot read the key %s: %v", key, err)
				}
			}
			if t.PrivateKey == "" && t.Password == "" {
				return errs.Usage("the connection string holds the private key: pass it with -k <file>")
			}
			a.emitter.Masker().Add(t.PrivateKey, t.Password)
			s, err := a.dial(ctx, t)
			if err != nil {
				return err
			}
			s.Close()
			srv := t.Server
			srv.HostKey = t.Verified
			cs := connection.ConnString{Servers: []connection.Server{srv}, PrivateKey: t.PrivateKey, Password: t.Password}.Encode()
			if a.json {
				return json.NewEncoder(a.stdout).Encode(map[string]string{"connection": cs, "host_key": t.Verified})
			}
			fmt.Fprintln(a.stdout, cs)
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVarP(&key, "key", "k", "", "the private key file the connection string holds (default DOCKFLOW_SSH_KEY)")
	f.StringVar(&hostKey, "host-key", "", "the server's host key fingerprint (SHA256:…), when known_hosts does not have it")
	f.StringVar(&name, "name", "", "the server's name (default main)")
	f.StringVar(&env, "env", "", "without a target: the environment whose server to use")
	return cmd
}

// parseTarget reads user@host[:port].
func parseTarget(s string) (connection.Server, error) {
	srv := connection.Server{}
	if user, rest, ok := strings.Cut(s, "@"); ok {
		srv.User, s = user, rest
	}
	srv.Host = s
	if h, p, err := net.SplitHostPort(s); err == nil {
		port, err := strconv.Atoi(p)
		if err != nil || port < 1 || port > 65535 {
			return srv, errs.Usage("%q is not a valid port", p)
		}
		srv.Host, srv.Port = h, port
	}
	if srv.Host == "" {
		return srv, errs.Usage("the target is user@host[:port]")
	}
	if srv.Port == 0 {
		srv.Port = 22
	}
	if srv.User == "" {
		srv.User = "dockflow"
	}
	return srv, nil
}
