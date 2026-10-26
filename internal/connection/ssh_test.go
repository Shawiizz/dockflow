package connection

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/pem"
	"net"
	"strconv"
	"testing"

	"golang.org/x/crypto/ssh"
)

// A server with several host keys, as Debian and Ubuntu have: the pinned ed25519 fingerprint,
// the one `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` prints, is the key it presents.
func TestPinnedEd25519KeyMatchesAServerWithSeveralKeys(t *testing.T) {
	_, edPriv, _ := ed25519.GenerateKey(rand.Reader)
	ecPriv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	rsaPriv, _ := rsa.GenerateKey(rand.Reader, 2048)
	cfg := &ssh.ServerConfig{NoClientAuth: true}
	var edPub ssh.PublicKey
	for _, k := range []any{rsaPriv, ecPriv, edPriv} {
		signer, err := ssh.NewSignerFromKey(k)
		if err != nil {
			t.Fatal(err)
		}
		cfg.AddHostKey(signer)
		if signer.PublicKey().Type() == ssh.KeyAlgoED25519 {
			edPub = signer.PublicKey()
		}
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
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
			go func() {
				sc, chans, reqs, err := ssh.NewServerConn(c, cfg)
				if err != nil {
					return
				}
				go ssh.DiscardRequests(reqs)
				for nc := range chans {
					nc.Reject(ssh.Prohibited, "no")
				}
				sc.Close()
			}()
		}
	}()
	host, port, _ := net.SplitHostPort(l.Addr().String())
	p, _ := strconv.Atoi(port)
	_, clientKey, _ := ed25519.GenerateKey(rand.Reader)
	block, _ := ssh.MarshalPrivateKey(clientKey, "")
	tgt := &Target{
		Server:     Server{Host: host, Port: p, User: "dockflow", HostKey: ssh.FingerprintSHA256(edPub)},
		PrivateKey: string(pemEncode(block)),
	}
	c, err := Dial(context.Background(), tgt)
	if err != nil {
		t.Fatalf("the pinned ed25519 key must match: %v", err)
	}
	c.Close()
	if tgt.Verified != ssh.FingerprintSHA256(edPub) {
		t.Fatalf("verified %s, want the ed25519 key", tgt.Verified)
	}
}

func pemEncode(b *pem.Block) []byte { return pem.EncodeToMemory(b) }
