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
	// Verified is the host key fingerprint SSH verified, once connected.
	Verified string
	// IdentityFiles are the keys ~/.ssh/config names for the host, tried after ssh-agent in
	// place of the default ones.
	IdentityFiles []string
	// JumpVerified and JumpIdentityFiles are the same for the bastion, when there is one.
	JumpVerified      string
	JumpIdentityFiles []string
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
		t := &Target{Server: c.Servers[0], PrivateKey: c.PrivateKey, Password: c.Password, FromString: true}
		t.jumpKeyFrom(env, getenv)
		return t, nil
	}
	if cfg == nil || cfg.Server == nil {
		return nil, errs.Config("no server for environment %s", env).
			WithHint("set the %s_CONNECTION secret (printed by `dockflow server connection`), or describe the server under environments.%s.server in %s",
				strings.ToUpper(env), env, config.FileName)
	}
	t := &Target{Server: Server{
		Name: cfg.Server.Name, Host: cfg.Server.Host, Port: cfg.Server.Port,
		User: cfg.Server.User, HostKey: cfg.Server.HostKey,
	}}
	if j := cfg.Server.Jump; j != nil {
		t.Server.Jump = &Jump{Host: j.Host, Port: j.Port, User: j.User, HostKey: j.HostKey}
	}
	// dockflow.yml wins over ~/.ssh/config, which wins over the defaults, as OpenSSH's command line
	if err := t.UseSSHConfig(cfg.Server.Port != 0, cfg.Server.User != ""); err != nil {
		return nil, err
	}
	t.Defaults("dockflow")
	t.jumpKeyFrom(env, getenv)
	for _, k := range []string{"DOCKFLOW_SSH_KEY_" + strings.ToUpper(env), "DOCKFLOW_SSH_KEY"} {
		if v := getenv(k); v != "" {
			t.PrivateKey = v
			break
		}
	}
	return t, nil
}

// Defaults sets what neither the caller nor ~/.ssh/config set: port 22 and user, and for the
// bastion port 22 and the server's user.
func (t *Target) Defaults(user string) {
	if t.Server.Port == 0 {
		t.Server.Port = 22
	}
	if t.Server.User == "" {
		t.Server.User = user
	}
	if j := t.Server.Jump; j != nil {
		if j.Port == 0 {
			j.Port = 22
		}
		if j.User == "" {
			j.User = t.Server.User
		}
	}
}

// jumpKeyFrom gives the bastion DOCKFLOW_SSH_JUMP_KEY_<ENV> or DOCKFLOW_SSH_JUMP_KEY, when it has
// no key of its own.
func (t *Target) jumpKeyFrom(env string, getenv func(string) string) {
	j := t.Server.Jump
	if j == nil || j.PrivateKey != "" {
		return
	}
	for _, k := range []string{"DOCKFLOW_SSH_JUMP_KEY_" + strings.ToUpper(env), "DOCKFLOW_SSH_JUMP_KEY"} {
		if v := getenv(k); v != "" {
			j.PrivateKey = v
			return
		}
	}
}

// Addr is host:port.
func (t *Target) Addr() string {
	return net.JoinHostPort(t.Server.Host, strconv.Itoa(t.Server.Port))
}

// HostKeyAlgorithms is the order in which the server is asked for its host key: ed25519 first,
// as OpenSSH does, so the key pinned from `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, or
// recorded by OpenSSH in known_hosts, is the one the server presents.
var HostKeyAlgorithms = []string{
	ssh.KeyAlgoED25519,
	ssh.KeyAlgoECDSA256, ssh.KeyAlgoECDSA384, ssh.KeyAlgoECDSA521,
	ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256,
}

// Dial opens an SSH connection, verifying the server's host key. Through a bastion, the bastion's
// host key is verified the same way, and the bastion's connection closes with the server's.
func Dial(ctx context.Context, t *Target) (*ssh.Client, error) {
	var signers []ssh.Signer
	if t.PrivateKey != "" {
		signer, err := parseKey(t.PrivateKey)
		if err != nil {
			return nil, err
		}
		signers = append(signers, signer)
	}
	auth, closeAuth := authMethods(signers, t.Password, t.IdentityFiles)
	defer closeAuth()
	if len(auth) == 0 {
		return nil, errs.Config("no SSH credentials for %s", t.Server.Host).
			WithHint("use a connection string, set DOCKFLOW_SSH_KEY, or load a key in ssh-agent")
	}
	serverKey := hostKeyCallback(t.Addr(), t.Server.HostKey, &t.Verified, false)
	j := t.Server.Jump
	if j == nil {
		conn, err := dialTCP(ctx, t.Addr())
		if err != nil {
			return nil, err
		}
		return handshake(conn, t.Addr(), t.Server.User, auth, serverKey)
	}
	// the bastion's own key first, then the server's, as OpenSSH tries every key it has
	var jumpSigners []ssh.Signer
	if j.PrivateKey != "" {
		signer, err := parseKey(j.PrivateKey)
		if err != nil {
			return nil, err
		}
		jumpSigners = append(jumpSigners, signer)
	}
	jumpAuth, closeJumpAuth := authMethods(append(jumpSigners, signers...), "", t.JumpIdentityFiles)
	defer closeJumpAuth()
	conn, err := dialTCP(ctx, j.Addr())
	if err != nil {
		return nil, err.WithHint("check the bastion's host and port, and that it accepts SSH from this machine")
	}
	bastion, herr := handshake(conn, j.Addr(), j.User, jumpAuth, hostKeyCallback(j.Addr(), j.HostKey, &t.JumpVerified, true))
	if herr != nil {
		return nil, herr
	}
	tunnel, derr := bastion.DialContext(ctx, "tcp", t.Addr())
	if derr != nil {
		bastion.Close()
		return nil, errs.Connect("the bastion %s cannot reach %s", j.Addr(), t.Addr()).WithCause(derr).
			WithHint("check the server's address as the bastion sees it, and that the bastion allows TCP forwarding (AllowTcpForwarding)")
	}
	c, herr := handshake(tunnel, t.Addr(), t.Server.User, auth, serverKey)
	if herr != nil {
		bastion.Close()
		return nil, herr
	}
	go func() {
		_ = c.Wait()
		bastion.Close()
	}()
	return c, nil
}

func dialTCP(ctx context.Context, addr string) (net.Conn, *errs.Error) {
	d := net.Dialer{Timeout: 20 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, errs.Connect("cannot reach %s", addr).WithCause(err).
			WithHint("check the host and port, and that the server accepts SSH from this machine")
	}
	return conn, nil
}

// handshake opens an SSH connection over conn, which it closes when it fails.
func handshake(conn net.Conn, addr, user string, auth []ssh.AuthMethod, hostKey ssh.HostKeyCallback) (*ssh.Client, error) {
	cfg := &ssh.ClientConfig{
		User:              user,
		Auth:              auth,
		HostKeyCallback:   hostKey,
		HostKeyAlgorithms: HostKeyAlgorithms,
		Timeout:           20 * time.Second,
	}
	// ClientConfig.Timeout covers only the TCP dial, which a tunnel through a bastion has not
	_ = conn.SetDeadline(time.Now().Add(cfg.Timeout))
	c, chans, reqs, err := ssh.NewClientConn(conn, addr, cfg)
	if err != nil {
		conn.Close()
		var hk *hostKeyError
		if errors.As(err, &hk) {
			return nil, hk.err
		}
		return nil, errs.Connect("SSH to %s@%s failed", user, addr).WithCause(err).
			WithHint("check the user and the key, or print the connection string again with `dockflow server connection`")
	}
	_ = conn.SetDeadline(time.Time{})
	return ssh.NewClient(c, chans, reqs), nil
}

// parseKey reads a private key, or the file it names.
func parseKey(key string) (ssh.Signer, error) {
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
			return nil, errs.Config("the SSH key is protected by a passphrase").
				WithHint("load it in ssh-agent, or use a key without passphrase for deploys")
		}
		return nil, errs.Config("the SSH private key cannot be read").WithCause(err)
	}
	return signer, nil
}

// authMethods are the keys and the password given; without any, ssh-agent's keys, then files, or
// the default keys when files is empty.
func authMethods(signers []ssh.Signer, password string, files []string) ([]ssh.AuthMethod, func()) {
	var methods []ssh.AuthMethod
	closeFn := func() {}
	if len(signers) > 0 {
		methods = append(methods, ssh.PublicKeys(signers...))
	}
	if password != "" {
		pw := password
		methods = append(methods, ssh.Password(pw), ssh.KeyboardInteractive(
			func(_, _ string, questions []string, _ []bool) ([]string, error) {
				answers := make([]string, len(questions))
				for i := range answers {
					answers[i] = pw
				}
				return answers, nil
			}))
	}
	if len(methods) > 0 {
		return methods, closeFn
	}
	if sock := os.Getenv("SSH_AUTH_SOCK"); sock != "" {
		if conn, err := net.Dial("unix", sock); err == nil {
			closeFn = func() { conn.Close() }
			methods = append(methods, ssh.PublicKeysCallback(agent.NewClient(conn).Signers))
		}
	}
	if len(files) == 0 {
		home, _ := os.UserHomeDir()
		for _, name := range []string{"id_ed25519", "id_ecdsa", "id_rsa"} {
			files = append(files, filepath.Join(home, ".ssh", name))
		}
	}
	for _, file := range files {
		b, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		if signer, err := ssh.ParsePrivateKey(b); err == nil {
			methods = append(methods, ssh.PublicKeys(signer))
		}
	}
	return methods, closeFn
}

type hostKeyError struct{ err *errs.Error }

func (e *hostKeyError) Error() string { return e.err.Error() }

// hostKeyCallback verifies the host key of addr against the pinned fingerprint, or against the
// user's known_hosts, and records it in verified. Nothing is ever trusted on first use (ADR-0013).
func hostKeyCallback(addr, pinned string, verified *string, jump bool) ssh.HostKeyCallback {
	what, pin := "", "host_key"
	if jump {
		what, pin = "the bastion ", "jump.host_key"
	}
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		got := ssh.FingerprintSHA256(key)
		if pinned != "" {
			if got == pinned {
				*verified = got
				return nil
			}
			return &hostKeyError{errs.Newf("ssh.host_key_mismatch", errs.ExitConnect,
				"the host key of %s%s is %s, not the pinned %s", what, addr, got, pinned).
				WithHint("if the server was reinstalled, verify the new key on the server (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub) and update the connection string")}
		}
		home, _ := os.UserHomeDir()
		kh := filepath.Join(home, ".ssh", "known_hosts")
		if cb, err := knownhosts.New(kh); err == nil {
			if err := cb(hostname, remote, key); err == nil {
				*verified = got
				return nil
			}
		}
		return &hostKeyError{errs.Newf("ssh.host_key_unknown", errs.ExitConnect,
			"the host key of %s%s (%s) is not pinned and not in known_hosts", what, addr, got).
			WithHint("verify it on the server (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub), then add %s: %q", pin, got)}
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
