package connection

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"

	"golang.org/x/crypto/ssh"

	"github.com/Shawiizz/dockflow/internal/errs"
)

// testServer is an SSH server that accepts the given keys and, as a bastion, opens the TCP
// connections it is asked for, recording them.
type testServer struct {
	addr, fingerprint string
	mu                sync.Mutex
	forwarded         []string
	users             []string
}

func newTestServer(t *testing.T, keys ...ssh.PublicKey) *testServer {
	t.Helper()
	_, hostPriv, _ := ed25519.GenerateKey(rand.Reader)
	host, _ := ssh.NewSignerFromKey(hostPriv)
	s := &testServer{fingerprint: ssh.FingerprintSHA256(host.PublicKey())}
	cfg := &ssh.ServerConfig{PublicKeyCallback: func(meta ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
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
