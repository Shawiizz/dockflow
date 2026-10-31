package cli

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"

	"github.com/Shawiizz/dockflow/internal/connection"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/provision"
)

// connectionCmd prints the connection string of a server, once it has reached it: the host key it
// holds is the one SSH verified, against --host-key or known_hosts (ADR-0013).
func (a *app) connectionCmd() *cobra.Command {
	var key, hostKey, name, env string
	var jf jumpFlags
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
				var err error
				if t, err = parseTarget(args[0], provision.DefaultUser, jf.jump); err != nil {
					return err
				}
				t.Server.HostKey, t.Server.Name = hostKey, name
			} else {
				if jf.jump != "" {
					return errs.Usage("--jump goes with a target; the bastion of an environment is server.jump in dockflow.yml")
				}
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
			if err := jf.apply(t); err != nil {
				return err
			}
			a.emitter.Masker().Add(t.PrivateKey, t.Password)
			if t.Server.Jump != nil {
				a.emitter.Masker().Add(t.Server.Jump.PrivateKey)
			}
			s, err := a.dial(ctx, t)
			if err != nil {
				return err
			}
			s.Close()
			srv := t.Server
			srv.HostKey = t.Verified
			if j := srv.Jump; j != nil {
				pinned := *j
				pinned.HostKey = t.JumpVerified
				srv.Jump = &pinned
			}
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
	jf.register(f, "with a target: ")
	return cmd
}

// jumpFlags are the bastion options of the commands that connect to a server.
type jumpFlags struct {
	jump, hostKey, key string
}

func (j *jumpFlags) register(f *pflag.FlagSet, when string) {
	f.StringVar(&j.jump, "jump", "", when+"the bastion the server is reached through, [user@]host[:port] (default: ProxyJump of ~/.ssh/config)")
	f.StringVar(&j.hostKey, "jump-host-key", "", "the bastion's host key fingerprint (SHA256:…), when known_hosts does not have it")
	f.StringVar(&j.key, "jump-key", "", "the bastion's private key file, when the server's key does not open it (default DOCKFLOW_SSH_JUMP_KEY); the connection string holds it")
}

// apply gives t's bastion the host key and the key of the flags, or DOCKFLOW_SSH_JUMP_KEY, read
// from its file: the connection string holds keys, not paths.
func (j *jumpFlags) apply(t *connection.Target) error {
	b := t.Server.Jump
	if b == nil {
		if j.hostKey != "" || j.key != "" {
			return errs.Usage("--jump-host-key and --jump-key need a bastion: --jump, or ProxyJump in ~/.ssh/config")
		}
		return nil
	}
	if j.hostKey != "" {
		b.HostKey = j.hostKey
	}
	key := j.key
	if key == "" && b.PrivateKey == "" {
		key = os.Getenv("DOCKFLOW_SSH_JUMP_KEY")
	}
	if key == "" {
		key = b.PrivateKey
	}
	if key != "" && !strings.Contains(key, "PRIVATE KEY") {
		content, err := os.ReadFile(key)
		if err != nil {
			return errs.Usage("cannot read the bastion's key %s: %v", key, err)
		}
		key = string(content)
	}
	b.PrivateKey = key
	return nil
}

// parseTarget reads user@host[:port], where host may be an alias of ~/.ssh/config: its HostName,
// Port, User, IdentityFile and ProxyJump apply where the target sets none, then 22 and
// defaultUser. jump, when set, is the bastion.
func parseTarget(s, defaultUser, jump string) (*connection.Target, error) {
	srv := connection.Server{}
	if user, rest, ok := strings.Cut(s, "@"); ok {
		srv.User, s = user, rest
	}
	srv.Host = s
	if h, p, err := net.SplitHostPort(s); err == nil {
		port, err := strconv.Atoi(p)
		if err != nil || port < 1 || port > 65535 {
			return nil, errs.Usage("%q is not a valid port", p)
		}
		srv.Host, srv.Port = h, port
	}
	if srv.Host == "" || (strings.Contains(s, "@") && srv.User == "") {
		return nil, errs.Usage("the target is user@host[:port]")
	}
	if jump != "" {
		j, err := connection.ParseJump(jump)
		if err != nil {
			return nil, errs.Usage("--jump: %s", err.Error())
		}
		srv.Jump = j
	}
	t := &connection.Target{Server: srv}
	if err := t.UseSSHConfig(srv.Port != 0, srv.User != ""); err != nil {
		return nil, err
	}
	t.Defaults(defaultUser)
	return t, nil
}
