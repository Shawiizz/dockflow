// Command sshd is a minimal SSH server for the e2e tests: public key authentication, stream-local
// forwarding to unix sockets, and exec sessions. It stands in for OpenSSH on the Docker-in-Docker
// server.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"

	"golang.org/x/crypto/ssh"
)

func main() {
	addr := flag.String("listen", ":2222", "address to listen on")
	authorized := flag.String("authorized-key", "/authorized_key", "authorized_keys-format public key")
	fingerprint := flag.String("fingerprint-file", "/host_key_fingerprint", "where to write the host key fingerprint")
	flag.Parse()

	b, err := os.ReadFile(*authorized)
	if err != nil {
		log.Fatal(err)
	}
	allowed, _, _, _, err := ssh.ParseAuthorizedKey(b)
	if err != nil {
		log.Fatal(err)
	}
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		log.Fatal(err)
	}
	cfg := &ssh.ServerConfig{PublicKeyCallback: func(meta ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
		if string(key.Marshal()) == string(allowed.Marshal()) {
			return nil, nil
		}
		// as OpenSSH: the keys in the user's own authorized_keys (commands still run as root)
		if userKeys(meta.User())[string(key.Marshal())] {
			return nil, nil
		}
		return nil, fmt.Errorf("unknown key")
	}}
	cfg.AddHostKey(signer)
	if err := os.WriteFile(*fingerprint, []byte(ssh.FingerprintSHA256(signer.PublicKey())), 0o644); err != nil {
		log.Fatal(err)
	}
	// where OpenSSH keeps it, for server init run on the server
	os.MkdirAll("/etc/ssh", 0o755)
	if err := os.WriteFile("/etc/ssh/ssh_host_ed25519_key.pub", ssh.MarshalAuthorizedKey(signer.PublicKey()), 0o644); err != nil {
		log.Fatal(err)
	}
	l, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	for {
		c, err := l.Accept()
		if err != nil {
			log.Fatal(err)
		}
		go serve(c, cfg)
	}
}

func serve(c net.Conn, cfg *ssh.ServerConfig) {
	_, chans, reqs, err := ssh.NewServerConn(c, cfg)
	if err != nil {
		c.Close()
		return
	}
	go ssh.DiscardRequests(reqs)
	for nc := range chans {
		switch nc.ChannelType() {
		case "direct-streamlocal@openssh.com":
			go streamlocal(nc)
		case "direct-tcpip":
			go directTCP(nc)
		case "session":
			go session(nc)
		default:
			nc.Reject(ssh.UnknownChannelType, "unsupported")
		}
	}
}

func directTCP(nc ssh.NewChannel) {
	var p struct {
		Host       string
		Port       uint32
		OriginIP   string
		OriginPort uint32
	}
	if err := ssh.Unmarshal(nc.ExtraData(), &p); err != nil {
		nc.Reject(ssh.ConnectionFailed, "bad payload")
		return
	}
	conn, err := net.Dial("tcp", net.JoinHostPort(p.Host, fmt.Sprint(p.Port)))
	if err != nil {
		nc.Reject(ssh.ConnectionFailed, err.Error())
		return
	}
	pipe(nc, conn)
}

func streamlocal(nc ssh.NewChannel) {
	var p struct {
		SocketPath string
		Reserved0  string
		Reserved1  uint32
	}
	if err := ssh.Unmarshal(nc.ExtraData(), &p); err != nil {
		nc.Reject(ssh.ConnectionFailed, "bad payload")
		return
	}
	conn, err := net.Dial("unix", p.SocketPath)
	if err != nil {
		nc.Reject(ssh.ConnectionFailed, err.Error())
		return
	}
	pipe(nc, conn)
}

// pipe accepts the channel and copies between it and conn until both sides close.
func pipe(nc ssh.NewChannel, conn net.Conn) {
	ch, reqs, err := nc.Accept()
	if err != nil {
		conn.Close()
		return
	}
	go ssh.DiscardRequests(reqs)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		io.Copy(ch, conn)
		ch.CloseWrite()
		wg.Done()
	}()
	go func() {
		io.Copy(conn, ch)
		if cw, ok := conn.(interface{ CloseWrite() error }); ok {
			cw.CloseWrite()
		}
		wg.Done()
	}()
	wg.Wait()
	ch.Close()
	conn.Close()
}

func session(nc ssh.NewChannel) {
	ch, reqs, err := nc.Accept()
	if err != nil {
		return
	}
	defer ch.Close()
	for req := range reqs {
		if req.Type != "exec" {
			req.Reply(req.Type == "env" || req.Type == "pty-req", nil)
			continue
		}
		var p struct{ Command string }
		ssh.Unmarshal(req.Payload, &p)
		req.Reply(true, nil)
		cmd := exec.Command("/bin/sh", "-c", p.Command)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = ch, ch, ch.Stderr()
		status := uint32(0)
		if err := cmd.Run(); err != nil {
			status = 1
			if ee, ok := err.(*exec.ExitError); ok {
				status = uint32(ee.ExitCode())
			}
		}
		ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{status}))
		return
	}
}

// userKeys reads ~user/.ssh/authorized_keys, options included.
func userKeys(user string) map[string]bool {
	keys := map[string]bool{}
	passwd, err := os.ReadFile("/etc/passwd")
	if err != nil {
		return keys
	}
	home := ""
	for _, line := range strings.Split(string(passwd), "\n") {
		f := strings.Split(line, ":")
		if len(f) > 5 && f[0] == user {
			home = f[5]
		}
	}
	if home == "" {
		return keys
	}
	rest, err := os.ReadFile(home + "/.ssh/authorized_keys")
	if err != nil {
		return keys
	}
	for len(rest) > 0 {
		var k ssh.PublicKey
		k, _, _, rest, err = ssh.ParseAuthorizedKey(rest)
		if err != nil {
			break
		}
		keys[string(k.Marshal())] = true
	}
	return keys
}
