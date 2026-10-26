package connection

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
	"golang.org/x/crypto/ssh/knownhosts"

	"github.com/Shawiizz/dockflow/internal/config"
	"github.com/Shawiizz/dockflow/internal/errs"
)

// Target is a server and the credentials to reach it.
type Target struct {
	Server     Server
	PrivateKey string
	Password   string
	// FromString tells whether the target came from a connection string.
	FromString bool
}

// Lookup reads a secret of the environment (PRODUCTION_X, then X).
type Lookup func(key string) (string, bool)

// Resolve finds how to reach env's server: --connection, then the <ENV>_CONNECTION secret, then
// the server in dockflow.yml with a key from DOCKFLOW_SSH_KEY_<ENV>, DOCKFLOW_SSH_KEY or ssh-agent.
func Resolve(env string, cfg *config.Resolved, secret Lookup, flag string, getenv func(string) string) (*Target, error) {
	raw := flag
	if raw == "" {
		if v, ok := secret("CONNECTION"); ok {
			raw = v
		}
	}
	if raw != "" {
		c, err := ParseConnString(raw)
		if err != nil {
			return nil, err
		}
		return &Target{Server: c.Servers[0], PrivateKey: c.PrivateKey, Password: c.Password, FromString: true}, nil
	}
	if cfg == nil || cfg.Server == nil {
		return nil, errs.Config("no server for environment %s", env).
			WithHint("set the %s_CONNECTION secret (printed by `dockflow server init`), or describe the server under environments.%s.server in %s",
				strings.ToUpper(env), env, config.FileName)
	}
	t := &Target{Server: Server{
		Name: cfg.Server.Name, Host: cfg.Server.Host, Port: cfg.Server.Port,
		User: cfg.Server.User, HostKey: cfg.Server.HostKey,
	}}
	for _, k := range []string{"DOCKFLOW_SSH_KEY_" + strings.ToUpper(env), "DOCKFLOW_SSH_KEY"} {
		if v := getenv(k); v != "" {
			t.PrivateKey = v
			break
		}
	}
	return t, nil
}

// Addr is host:port.
func (t *Target) Addr() string {
	return net.JoinHostPort(t.Server.Host, strconv.Itoa(t.Server.Port))
}

// Dial opens an SSH connection, verifying the server's host key.
func Dial(ctx context.Context, t *Target) (*ssh.Client, error) {
	auth, closeAuth, err := authMethods(t)
	if err != nil {
		return nil, err
	}
	defer closeAuth()
	cfg := &ssh.ClientConfig{
		User:            t.Server.User,
		Auth:            auth,
		HostKeyCallback: hostKeyCallback(t),
		Timeout:         20 * time.Second,
	}
	d := net.Dialer{Timeout: 20 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", t.Addr())
	if err != nil {
		return nil, errs.Connect("cannot reach %s", t.Addr()).WithCause(err).
			WithHint("check the host and port, and that the server accepts SSH from this machine")
	}
	c, chans, reqs, err := ssh.NewClientConn(conn, t.Addr(), cfg)
	if err != nil {
		conn.Close()
		var hk *hostKeyError
		if errors.As(err, &hk) {
			return nil, hk.err
		}
		return nil, errs.Connect("SSH to %s@%s failed", t.Server.User, t.Addr()).WithCause(err).
			WithHint("check the user and the key, or print the connection string again with `dockflow server connection`")
	}
	return ssh.NewClient(c, chans, reqs), nil
}

func authMethods(t *Target) ([]ssh.AuthMethod, func(), error) {
	var methods []ssh.AuthMethod
	closeFn := func() {}
	if t.PrivateKey != "" {
		key := t.PrivateKey
		if !strings.Contains(key, "PRIVATE KEY") {
			// DOCKFLOW_SSH_KEY may also hold a path
			if b, err := os.ReadFile(key); err == nil {
				key = string(b)
			}
		}
		signer, err := ssh.ParsePrivateKey([]byte(key))
		if err != nil {
			var missing *ssh.PassphraseMissingError
			if errors.As(err, &missing) {
				return nil, closeFn, errs.Config("the SSH key is protected by a passphrase").
					WithHint("load it in ssh-agent, or use a key without passphrase for deploys")
			}
			return nil, closeFn, errs.Config("the SSH private key cannot be read").WithCause(err)
		}
		methods = append(methods, ssh.PublicKeys(signer))
	}
	if t.Password != "" {
		pw := t.Password
		methods = append(methods, ssh.Password(pw), ssh.KeyboardInteractive(
			func(_, _ string, questions []string, _ []bool) ([]string, error) {
				answers := make([]string, len(questions))
				for i := range answers {
					answers[i] = pw
				}
				return answers, nil
			}))
	}
	if len(methods) == 0 {
		if sock := os.Getenv("SSH_AUTH_SOCK"); sock != "" {
			if conn, err := net.Dial("unix", sock); err == nil {
				closeFn = func() { conn.Close() }
				methods = append(methods, ssh.PublicKeysCallback(agent.NewClient(conn).Signers))
			}
		}
		home, _ := os.UserHomeDir()
		for _, name := range []string{"id_ed25519", "id_ecdsa", "id_rsa"} {
			b, err := os.ReadFile(filepath.Join(home, ".ssh", name))
			if err != nil {
				continue
			}
			if signer, err := ssh.ParsePrivateKey(b); err == nil {
				methods = append(methods, ssh.PublicKeys(signer))
			}
		}
	}
	if len(methods) == 0 {
		return nil, closeFn, errs.Config("no SSH credentials for %s", t.Server.Host).
			WithHint("use a connection string, set DOCKFLOW_SSH_KEY, or load a key in ssh-agent")
	}
	return methods, closeFn, nil
}

type hostKeyError struct{ err *errs.Error }

func (e *hostKeyError) Error() string { return e.err.Error() }

// hostKeyCallback verifies the host key against the pinned fingerprint, or against the user's
// known_hosts. Nothing is ever trusted on first use (ADR-0013).
func hostKeyCallback(t *Target) ssh.HostKeyCallback {
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		got := ssh.FingerprintSHA256(key)
		if t.Server.HostKey != "" {
			if got == t.Server.HostKey {
				return nil
			}
			return &hostKeyError{errs.Newf("ssh.host_key_mismatch", errs.ExitConnect,
				"the host key of %s is %s, not the pinned %s", t.Addr(), got, t.Server.HostKey).
				WithHint("if the server was reinstalled, verify the new key on the server (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub) and update the connection string")}
		}
		home, _ := os.UserHomeDir()
		kh := filepath.Join(home, ".ssh", "known_hosts")
		if cb, err := knownhosts.New(kh); err == nil {
			if err := cb(hostname, remote, key); err == nil {
				return nil
			}
		}
		return &hostKeyError{errs.Newf("ssh.host_key_unknown", errs.ExitConnect,
			"the host key of %s (%s) is not pinned and not in known_hosts", t.Addr(), got).
			WithHint("verify it on the server (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub), then add host_key: %q", got)}
	}
}

// DockerSocket is where the Docker API listens on the server.
const DockerSocket = "/var/run/docker.sock"

// DockerDialer returns a dialer that reaches the server's Docker socket through the SSH
// connection: stream-local forwarding, or `docker system dial-stdio` when the server refuses it.
func DockerDialer(c *ssh.Client) func(ctx context.Context, network, addr string) (net.Conn, error) {
	var mu sync.Mutex
	useStdio := false
	return func(ctx context.Context, _, _ string) (net.Conn, error) {
		mu.Lock()
		stdio := useStdio
		mu.Unlock()
		if !stdio {
			conn, err := c.Dial("unix", DockerSocket)
			if err == nil {
				return conn, nil
			}
			var open *ssh.OpenChannelError
			if !errors.As(err, &open) {
				return nil, errs.Connect("cannot reach the Docker socket of the server").WithCause(err)
			}
			mu.Lock()
			useStdio = true
			mu.Unlock()
		}
		return dialStdio(c)
	}
}

// dialStdio runs `docker system dial-stdio` and uses its stdin and stdout as the connection.
func dialStdio(c *ssh.Client) (net.Conn, error) {
	sess, err := c.NewSession()
	if err != nil {
		return nil, errs.Connect("cannot open an SSH session").WithCause(err)
	}
	stdin, err := sess.StdinPipe()
	if err != nil {
		sess.Close()
		return nil, err
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		sess.Close()
		return nil, err
	}
	if err := sess.Start("docker system dial-stdio"); err != nil {
		sess.Close()
		return nil, errs.Connect("the server refuses stream forwarding and `docker system dial-stdio` failed").WithCause(err).
			WithHint("allow stream-local forwarding (AllowStreamLocalForwarding yes) or install the docker CLI on the server")
	}
	return &stdioConn{sess: sess, r: stdout, w: stdin}, nil
}

type stdioConn struct {
	sess *ssh.Session
	r    io.Reader
	w    io.WriteCloser
}

func (c *stdioConn) Read(b []byte) (int, error)  { return c.r.Read(b) }
func (c *stdioConn) Write(b []byte) (int, error) { return c.w.Write(b) }
func (c *stdioConn) Close() error {
	c.w.Close()
	return c.sess.Close()
}
func (c *stdioConn) LocalAddr() net.Addr              { return stdioAddr{} }
func (c *stdioConn) RemoteAddr() net.Addr             { return stdioAddr{} }
func (c *stdioConn) SetDeadline(time.Time) error      { return nil }
func (c *stdioConn) SetReadDeadline(time.Time) error  { return nil }
func (c *stdioConn) SetWriteDeadline(time.Time) error { return nil }

type stdioAddr struct{}

func (stdioAddr) Network() string { return "stdio" }
func (stdioAddr) String() string  { return "docker-dial-stdio" }

// Fingerprint returns the SHA256 fingerprint of an authorized_keys-format public key.
func Fingerprint(authorizedKey string) (string, error) {
	pk, _, _, _, err := ssh.ParseAuthorizedKey([]byte(authorizedKey))
	if err != nil {
		return "", fmt.Errorf("not a public key: %w", err)
	}
	return ssh.FingerprintSHA256(pk), nil
}
