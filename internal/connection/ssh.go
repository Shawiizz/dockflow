package connection

import (
	"bytes"
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
	// IdentitiesOnly is IdentitiesOnly of ~/.ssh/config: only the IdentityFile keys are offered.
	IdentitiesOnly bool
	// JumpVerified, JumpIdentityFiles and JumpIdentitiesOnly are the same for the bastion, when
	// there is one.
	JumpVerified       string
	JumpIdentityFiles  []string
	JumpIdentitiesOnly bool
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

// HandshakeTimeout bounds the SSH handshake, behind a bastion too, where the connection is an SSH
// channel that has no deadline: a server that accepts the connection and never answers fails
// instead of holding the deploy.
var HandshakeTimeout = 20 * time.Second

// Dial opens an SSH connection, verifying the server's host key. Through a bastion, the bastion's
// host key is verified the same way, and the bastion's connection closes with the server's.
func Dial(ctx context.Context, t *Target) (*ssh.Client, error) {
	var deployKey []ssh.Signer
	if t.PrivateKey != "" {
		signer, err := parseKey(t.PrivateKey)
		if err != nil {
			return nil, err
		}
		deployKey = []ssh.Signer{signer}
	}
	keys := deployKey
	if len(keys) == 0 && t.Password == "" {
		found, closeAgent := discoverKeys(t.IdentityFiles, t.IdentitiesOnly)
		defer closeAgent()
		keys = found
	}
	auth := authMethods(keys, t.Password)
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
		return handshake(ctx, conn, t.Addr(), t.Server.User, auth, serverKey)
	}
	// the bastion's own key, then ssh-agent's and its IdentityFile keys, as OpenSSH offers them,
	// and the server's key last: it is not the bastion's, and each key offered uses one of the
	// bastion's MaxAuthTries
	var jumpKeys []ssh.Signer
	if j.PrivateKey != "" {
		signer, err := parseKey(j.PrivateKey)
		if err != nil {
			return nil, err
		}
		jumpKeys = append(jumpKeys, signer)
	}
	found, closeJumpAgent := discoverKeys(t.JumpIdentityFiles, t.JumpIdentitiesOnly)
	defer closeJumpAgent()
	for _, k := range found {
		// the deploy key stays last, ssh-agent holding it too
		if heldBy(deployKey, k.PublicKey()) == nil {
			jumpKeys = append(jumpKeys, k)
		}
	}
	jumpKeys = append(jumpKeys, deployKey...)
	conn, err := dialTCP(ctx, j.Addr())
	if err != nil {
		return nil, err.WithHint("check the bastion's host and port, and that it accepts SSH from this machine")
	}
	bastion, herr := handshake(ctx, conn, j.Addr(), j.User, authMethods(jumpKeys, ""), hostKeyCallback(j.Addr(), j.HostKey, &t.JumpVerified, true))
	if herr != nil {
		return nil, herr
	}
	tunnel, derr := bastion.DialContext(ctx, "tcp", t.Addr())
	if derr != nil {
		bastion.Close()
		return nil, errs.Connect("the bastion %s cannot reach %s", j.Addr(), t.Addr()).WithCause(derr).
			WithHint("check the server's address as the bastion sees it, and that the bastion allows TCP forwarding (AllowTcpForwarding)")
	}
	c, herr := handshake(ctx, tunnel, t.Addr(), t.Server.User, auth, serverKey)
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

// handshake opens an SSH connection over conn, within HandshakeTimeout and ctx, closing conn when
// it fails. The handshake runs aside, as a channel through a bastion has no deadline: closing
// conn ends it.
func handshake(ctx context.Context, conn net.Conn, addr, user string, auth []ssh.AuthMethod, hostKey ssh.HostKeyCallback) (*ssh.Client, error) {
	cfg := &ssh.ClientConfig{
		User:              user,
		Auth:              auth,
		HostKeyCallback:   hostKey,
		HostKeyAlgorithms: HostKeyAlgorithms,
	}
	type result struct {
		c     ssh.Conn
		chans <-chan ssh.NewChannel
		reqs  <-chan *ssh.Request
		err   error
	}
	done := make(chan result, 1)
	go func() {
		c, chans, reqs, err := ssh.NewClientConn(conn, addr, cfg)
		done <- result{c, chans, reqs, err}
	}()
	timer := time.NewTimer(HandshakeTimeout)
	defer timer.Stop()
	var r result
	select {
	case r = <-done:
	case <-timer.C:
		conn.Close()
		return nil, errs.Connect("%s accepted the connection, but SSH did not answer within %s", addr, HandshakeTimeout).
			WithHint("check that the SSH server of %s is running and not overloaded", addr)
	case <-ctx.Done():
		conn.Close()
		return nil, errs.Connect("SSH to %s was cancelled", addr).WithCause(ctx.Err())
	}
	if r.err != nil {
		conn.Close()
		var hk *hostKeyError
		if errors.As(r.err, &hk) {
			return nil, hk.err
		}
		e := errs.Connect("SSH to %s@%s failed", user, addr).WithCause(r.err)
		if strings.Contains(strings.ToLower(r.err.Error()), "too many authentication failures") {
			// more keys in ssh-agent than the server's MaxAuthTries
			return nil, e.WithHint("the server stopped before the right key: set IdentitiesOnly yes for %s in ~/.ssh/config, or give the key (DOCKFLOW_SSH_KEY, DOCKFLOW_SSH_JUMP_KEY for a bastion)", addr)
		}
		return nil, e.WithHint("check the user and the key, or print the connection string again with `dockflow server connection`")
	}
	return ssh.NewClient(r.c, r.chans, r.reqs), nil
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

// authMethods offers the keys, in order and each once, then the password. A key both in ssh-agent
// and on the disk is offered once, as OpenSSH does: each offer uses one of the server's
// MaxAuthTries. The keys are one method: the SSH library does not try a method again once the
// server refused it, so a method per key would skip every key after the first refused one.
func authMethods(keys []ssh.Signer, password string) []ssh.AuthMethod {
	var methods []ssh.AuthMethod
	var unique []ssh.Signer
	for _, k := range keys {
		if heldBy(unique, k.PublicKey()) == nil {
			unique = append(unique, k)
		}
	}
	if len(unique) > 0 {
		methods = append(methods, ssh.PublicKeys(unique...))
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
	return methods
}

// discoverKeys returns ssh-agent's keys, then those of files, or of the default files when files
// is empty, and closes the agent's connection when done. With only, as OpenSSH's IdentitiesOnly,
// it returns the files' keys alone, taken from ssh-agent when it holds them. The agent's key is
// recognised by the file's public key: the file itself when it is a public key (as 1Password and
// Secretive advise), else its .pub, which is all there is for a key protected by a passphrase or
// kept off the disk.
func discoverKeys(files []string, only bool) ([]ssh.Signer, func()) {
	var agentKeys []ssh.Signer
	closeFn := func() {}
	if sock := os.Getenv("SSH_AUTH_SOCK"); sock != "" {
		if conn, err := net.Dial("unix", sock); err == nil {
			closeFn = func() { conn.Close() }
			if signers, err := agent.NewClient(conn).Signers(); err == nil {
				agentKeys = signers
			}
		}
	}
	if len(files) == 0 {
		home, _ := os.UserHomeDir()
		for _, name := range []string{"id_ed25519", "id_ecdsa", "id_rsa"} {
			files = append(files, filepath.Join(home, ".ssh", name))
		}
	}
	var keys []ssh.Signer
	if !only {
		keys = append(keys, agentKeys...)
	}
	for _, file := range files {
		var signer ssh.Signer
		var pub ssh.PublicKey
		if b, err := os.ReadFile(file); err == nil {
			if signer, err = ssh.ParsePrivateKey(b); err == nil {
				pub = signer.PublicKey()
			} else {
				pub, _, _, _, _ = ssh.ParseAuthorizedKey(b)
			}
		}
		if !only {
			if signer != nil {
				keys = append(keys, signer)
			}
			continue
		}
		if pub == nil {
			if b, err := os.ReadFile(file + ".pub"); err == nil {
				pub, _, _, _, _ = ssh.ParseAuthorizedKey(b)
			}
		}
		if held := heldBy(agentKeys, pub); held != nil {
			keys = append(keys, held)
		} else if signer != nil {
			keys = append(keys, signer)
		}
	}
	return keys, closeFn
}

// heldBy returns the key of signers whose public key is pub.
func heldBy(signers []ssh.Signer, pub ssh.PublicKey) ssh.Signer {
	if pub == nil {
		return nil
	}
	for _, s := range signers {
		if bytes.Equal(s.PublicKey().Marshal(), pub.Marshal()) {
			return s
		}
	}
	return nil
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
