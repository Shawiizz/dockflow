package connection

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"

	"github.com/Shawiizz/dockflow/internal/errs"
)

// testServer is an SSH server that accepts the given keys and, as a bastion, opens the TCP
// connections it is asked for, recording them.
type testServer struct {
	addr, fingerprint string
	mu                sync.Mutex
	forwarded         []string
	users             []string
	// offered are the keys clients offered, in order
	offered []string
}

func newTestServer(t *testing.T, keys ...ssh.PublicKey) *testServer {
	t.Helper()
	_, hostPriv, _ := ed25519.GenerateKey(rand.Reader)
	host, _ := ssh.NewSignerFromKey(hostPriv)
	s := &testServer{fingerprint: ssh.FingerprintSHA256(host.PublicKey())}
	cfg := &ssh.ServerConfig{PublicKeyCallback: func(meta ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
		s.mu.Lock()
		s.offered = append(s.offered, ssh.FingerprintSHA256(key))
		s.mu.Unlock()
		for _, k := range keys {
			if string(k.Marshal()) == string(key.Marshal()) {
				s.mu.Lock()
				s.users = append(s.users, meta.User())
				s.mu.Unlock()
				return nil, nil
			}
		}
		return nil, fmt.Errorf("unknown key")
	}}
	cfg.AddHostKey(host)
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	s.addr = l.Addr().String()
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go s.serve(c, cfg)
		}
	}()
	return s
}

func (s *testServer) serve(c net.Conn, cfg *ssh.ServerConfig) {
	sc, chans, reqs, err := ssh.NewServerConn(c, cfg)
	if err != nil {
		c.Close()
		return
	}
	defer sc.Close()
	go ssh.DiscardRequests(reqs)
	for nc := range chans {
		if nc.ChannelType() != "direct-tcpip" {
			nc.Reject(ssh.UnknownChannelType, "no")
			continue
		}
		var p struct {
			Host       string
			Port       uint32
			OriginIP   string
			OriginPort uint32
		}
		ssh.Unmarshal(nc.ExtraData(), &p)
		addr := net.JoinHostPort(p.Host, strconv.Itoa(int(p.Port)))
		s.mu.Lock()
		s.forwarded = append(s.forwarded, addr)
		s.mu.Unlock()
		conn, err := net.Dial("tcp", addr)
		if err != nil {
			nc.Reject(ssh.ConnectionFailed, err.Error())
			continue
		}
		ch, creqs, err := nc.Accept()
		if err != nil {
			conn.Close()
			continue
		}
		go ssh.DiscardRequests(creqs)
		go func() { io.Copy(ch, conn); ch.CloseWrite() }()
		go func() { io.Copy(conn, ch); conn.Close() }()
	}
}

func (s *testServer) hostPort(t *testing.T) (string, int) {
	h, p, _ := net.SplitHostPort(s.addr)
	port, _ := strconv.Atoi(p)
	return h, port
}

func testKey(t *testing.T) (string, ssh.PublicKey) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	block, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatal(err)
	}
	signer, _ := ssh.NewSignerFromKey(priv)
	return string(pemEncode(block)), signer.PublicKey()
}

// Through a bastion, both host keys are verified, the bastion opens the connection to the server,
// and its own key opens it when the server's does not.
func TestDialThroughBastion(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SSH_AUTH_SOCK", "")
	deployKey, deployPub := testKey(t)
	jumpKey, jumpPub := testKey(t)
	server := newTestServer(t, deployPub)
	bastion := newTestServer(t, jumpPub)
	sh, sp := server.hostPort(t)
	bh, bp := bastion.hostPort(t)
	jump := func() *Jump {
		return &Jump{Host: bh, Port: bp, User: "admin", HostKey: bastion.fingerprint, PrivateKey: jumpKey}
	}
	tgt := &Target{
		Server:     Server{Host: sh, Port: sp, User: "dockflow", HostKey: server.fingerprint, Jump: jump()},
		PrivateKey: deployKey,
	}
	c, err := Dial(context.Background(), tgt)
	if err != nil {
		t.Fatalf("dial through the bastion: %v", err)
	}
	c.Close()
	if tgt.Verified != server.fingerprint || tgt.JumpVerified != bastion.fingerprint {
		t.Fatalf("verified %s and %s", tgt.Verified, tgt.JumpVerified)
	}
	if len(bastion.forwarded) != 1 || bastion.forwarded[0] != server.addr {
		t.Fatalf("the bastion must open the connection to the server, forwarded %v", bastion.forwarded)
	}
	if len(bastion.users) == 0 || bastion.users[0] != "admin" {
		t.Fatalf("the bastion's user is admin, got %v", bastion.users)
	}

	// a bastion whose host key is not the pinned one is refused before anything goes through it
	bad := jump()
	bad.HostKey = server.fingerprint
	tgt = &Target{Server: Server{Host: sh, Port: sp, User: "dockflow", HostKey: server.fingerprint, Jump: bad}, PrivateKey: deployKey}
	_, err = Dial(context.Background(), tgt)
	if e, ok := errs.As(err); !ok || e.Code != "ssh.host_key_mismatch" || !strings.Contains(e.Message, "bastion") {
		t.Fatalf("a wrong bastion host key must be refused: %v", err)
	}
	if len(bastion.forwarded) != 1 {
		t.Fatalf("nothing goes through a bastion that is not verified")
	}

	// without its own key, the bastion is tried with the server's
	shared := newTestServer(t, deployPub)
	jh, jp := shared.hostPort(t)
	tgt = &Target{
		Server:     Server{Host: sh, Port: sp, User: "dockflow", HostKey: server.fingerprint, Jump: &Jump{Host: jh, Port: jp, User: "admin", HostKey: shared.fingerprint}},
		PrivateKey: deployKey,
	}
	if c, err = Dial(context.Background(), tgt); err != nil {
		t.Fatalf("the server's key must be tried on the bastion: %v", err)
	}
	c.Close()

	// the server's host key is still verified behind the bastion
	tgt = &Target{
		Server:     Server{Host: sh, Port: sp, User: "dockflow", HostKey: bastion.fingerprint, Jump: jump()},
		PrivateKey: deployKey,
	}
	_, err = Dial(context.Background(), tgt)
	if e, ok := errs.As(err); !ok || e.Code != "ssh.host_key_mismatch" || strings.Contains(e.Message, "bastion") {
		t.Fatalf("a wrong server host key must be refused behind the bastion: %v", err)
	}
}

// The bastion is offered ssh-agent's keys even when the server has its deploy key, which comes
// last: in a company, the bastion takes the person's key and the server the deploy key.
func TestBastionTakesTheAgentsKey(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	deployKey, deployPub := testKey(t)
	_, personal, _ := ed25519.GenerateKey(rand.Reader)
	keyring := agent.NewKeyring()
	if err := keyring.Add(agent.AddedKey{PrivateKey: personal}); err != nil {
		t.Fatal(err)
	}
	sock := filepath.Join(t.TempDir(), "agent.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go agent.ServeAgent(keyring, c)
		}
	}()
	t.Setenv("SSH_AUTH_SOCK", sock)
	personalSigner, _ := ssh.NewSignerFromKey(personal)

	server := newTestServer(t, deployPub)
	bastion := newTestServer(t, personalSigner.PublicKey())
	sh, sp := server.hostPort(t)
	bh, bp := bastion.hostPort(t)
	tgt := &Target{
		Server:     Server{Host: sh, Port: sp, User: "dockflow", HostKey: server.fingerprint, Jump: &Jump{Host: bh, Port: bp, User: "me", HostKey: bastion.fingerprint}},
		PrivateKey: deployKey,
	}
	c, err := Dial(context.Background(), tgt)
	if err != nil {
		t.Fatalf("the bastion must be opened with the agent's key: %v", err)
	}
	c.Close()
	bastion.mu.Lock()
	defer bastion.mu.Unlock()
	for _, fp := range bastion.offered {
		if fp == ssh.FingerprintSHA256(deployPub) {
			t.Fatalf("the deploy key comes after the agent's, which opened the bastion: %v", bastion.offered)
		}
	}
}

// A server behind the bastion that accepts the connection and never answers fails within
// HandshakeTimeout instead of holding the deploy.
func TestSilentServerBehindBastionTimesOut(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SSH_AUTH_SOCK", "")
	defer func(d time.Duration) { HandshakeTimeout = d }(HandshakeTimeout)
	HandshakeTimeout = 300 * time.Millisecond
	silent, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer silent.Close()
	go func() {
		for {
			c, err := silent.Accept()
			if err != nil {
				return
			}
			defer c.Close()
		}
	}()
	deployKey, deployPub := testKey(t)
	bastion := newTestServer(t, deployPub)
	bh, bp := bastion.hostPort(t)
	h, p, _ := net.SplitHostPort(silent.Addr().String())
	port, _ := strconv.Atoi(p)
	tgt := &Target{
		Server:     Server{Host: h, Port: port, User: "dockflow", HostKey: "SHA256:x", Jump: &Jump{Host: bh, Port: bp, User: "me", HostKey: bastion.fingerprint}},
		PrivateKey: deployKey,
	}
	start := time.Now()
	_, err = Dial(context.Background(), tgt)
	if err == nil || !strings.Contains(err.Error(), "did not answer") {
		t.Fatalf("a silent server must fail, got %v", err)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("it took %s", d)
	}

	// and a cancelled context ends it too
	HandshakeTimeout = time.Minute
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	start = time.Now()
	if _, err = Dial(ctx, tgt); err == nil || time.Since(start) > 5*time.Second {
		t.Fatalf("a cancelled context must end the handshake: %v after %s", err, time.Since(start))
	}
}

// With IdentitiesOnly, the bastion is offered only its IdentityFile key, from ssh-agent when the
// agent holds it, and none of the agent's other keys. The agent's key is found from a private key
// protected by a passphrase and its .pub, from an IdentityFile that is the public key itself (as
// 1Password advises), and from a .pub alone, the private key kept off the disk (Secretive).
func TestIdentitiesOnly(t *testing.T) {
	cases := map[string]func(dir string, mine ed25519.PrivateKey, pub ssh.PublicKey) string{
		"passphrase": func(dir string, mine ed25519.PrivateKey, pub ssh.PublicKey) string {
			block, _ := ssh.MarshalPrivateKeyWithPassphrase(mine, "", []byte("secret"))
			os.WriteFile(filepath.Join(dir, "bastion_key"), pemEncode(block), 0o600)
			os.WriteFile(filepath.Join(dir, "bastion_key.pub"), ssh.MarshalAuthorizedKey(pub), 0o644)
			return filepath.Join(dir, "bastion_key")
		},
		"public key file": func(dir string, _ ed25519.PrivateKey, pub ssh.PublicKey) string {
			os.WriteFile(filepath.Join(dir, "bastion.pub"), ssh.MarshalAuthorizedKey(pub), 0o644)
			return filepath.Join(dir, "bastion.pub")
		},
		"pub alone": func(dir string, _ ed25519.PrivateKey, pub ssh.PublicKey) string {
			os.WriteFile(filepath.Join(dir, "bastion.pub"), ssh.MarshalAuthorizedKey(pub), 0o644)
			return filepath.Join(dir, "bastion")
		},
	}
	for name, identityFile := range cases {
		t.Run(name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			keyring := agent.NewKeyring()
			var others []string
			for i := 0; i < 3; i++ {
				_, k, _ := ed25519.GenerateKey(rand.Reader)
				keyring.Add(agent.AddedKey{PrivateKey: k})
				s, _ := ssh.NewSignerFromKey(k)
				others = append(others, ssh.FingerprintSHA256(s.PublicKey()))
			}
			_, mine, _ := ed25519.GenerateKey(rand.Reader)
			keyring.Add(agent.AddedKey{PrivateKey: mine})
			mineSigner, _ := ssh.NewSignerFromKey(mine)
			dir := filepath.Join(home, ".ssh")
			os.MkdirAll(dir, 0o700)
			file := identityFile(dir, mine, mineSigner.PublicKey())
			sock := filepath.Join(t.TempDir(), "agent.sock")
			l, err := net.Listen("unix", sock)
			if err != nil {
				t.Fatal(err)
			}
			defer l.Close()
			go func() {
				for {
					c, err := l.Accept()
					if err != nil {
						return
					}
					go agent.ServeAgent(keyring, c)
				}
			}()
			t.Setenv("SSH_AUTH_SOCK", sock)

			deployKey, deployPub := testKey(t)
			server := newTestServer(t, deployPub)
			bastion := newTestServer(t, mineSigner.PublicKey())
			sh, sp := server.hostPort(t)
			bh, bp := bastion.hostPort(t)
			tgt := &Target{
				Server:             Server{Host: sh, Port: sp, User: "dockflow", HostKey: server.fingerprint, Jump: &Jump{Host: bh, Port: bp, User: "me", HostKey: bastion.fingerprint}},
				PrivateKey:         deployKey,
				JumpIdentityFiles:  []string{file},
				JumpIdentitiesOnly: true,
			}
			c, err := Dial(context.Background(), tgt)
			if err != nil {
				t.Fatalf("the agent's copy of the IdentityFile key must open the bastion: %v", err)
			}
			c.Close()
			bastion.mu.Lock()
			defer bastion.mu.Unlock()
			for _, fp := range bastion.offered {
				for _, other := range others {
					if fp == other {
						t.Fatalf("IdentitiesOnly offers no other agent key: %v", bastion.offered)
					}
				}
			}
		})
	}
}

// A key both in ssh-agent and on the disk, and the deploy key when the agent holds it too, is
// offered once.
func TestKeysAreOfferedOnce(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	_, mine, _ := ed25519.GenerateKey(rand.Reader)
	deployKey, deployPub := testKey(t)
	deploySigner, _ := parseKey(deployKey)
	keyring := agent.NewKeyring()
	keyring.Add(agent.AddedKey{PrivateKey: mine})
	os.MkdirAll(filepath.Join(home, ".ssh"), 0o700)
	block, _ := ssh.MarshalPrivateKey(mine, "")
	os.WriteFile(filepath.Join(home, ".ssh", "id_ed25519"), pemEncode(block), 0o600)
	sock := filepath.Join(t.TempDir(), "agent.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go agent.ServeAgent(keyring, c)
		}
	}()
	t.Setenv("SSH_AUTH_SOCK", sock)
	// the deploy key is in the agent too
	raw, _ := ssh.ParseRawPrivateKey([]byte(deployKey))
	keyring.Add(agent.AddedKey{PrivateKey: raw})

	// a bastion that takes no key sees every key offered
	server := newTestServer(t, deployPub)
	bastion := newTestServer(t)
	sh, sp := server.hostPort(t)
	bh, bp := bastion.hostPort(t)
	tgt := &Target{
		Server:     Server{Host: sh, Port: sp, User: "dockflow", HostKey: server.fingerprint, Jump: &Jump{Host: bh, Port: bp, User: "me", HostKey: bastion.fingerprint}},
		PrivateKey: deployKey,
	}
	if _, err := Dial(context.Background(), tgt); err == nil {
		t.Fatal("the bastion takes no key")
	}
	bastion.mu.Lock()
	defer bastion.mu.Unlock()
	seen := map[string]bool{}
	for _, fp := range bastion.offered {
		if seen[fp] {
			t.Fatalf("a key was offered twice: %v", bastion.offered)
		}
		seen[fp] = true
	}
	if len(seen) != 2 || !seen[ssh.FingerprintSHA256(deploySigner.PublicKey())] {
		t.Fatalf("the agent's key and the deploy key, each once: %v", bastion.offered)
	}
}
