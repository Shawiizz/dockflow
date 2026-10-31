// Package connection resolves how to reach an environment's server (ADR-0013): a connection
// string or the server described in dockflow.yml, SSH with mandatory host key verification, and
// the Docker API through the SSH connection (ADR-0005).
package connection

import (
	"encoding/base64"
	"encoding/json"
	"net"
	"strconv"
	"strings"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
)

// Server is a server an environment deploys to.
type Server struct {
	Name    string `json:"name"`
	Host    string `json:"host"`
	Port    int    `json:"port"`
	User    string `json:"user"`
	HostKey string `json:"host_key,omitempty"`
	// Jump is the SSH server the server is reached through, as OpenSSH's ProxyJump: a bastion.
	Jump *Jump `json:"jump,omitempty"`
}

// Jump is a bastion: an SSH server that opens the TCP connection to the server.
type Jump struct {
	Host    string `json:"host"`
	Port    int    `json:"port,omitempty"`
	User    string `json:"user,omitempty"`
	HostKey string `json:"host_key,omitempty"`
	// PrivateKey is the bastion's own key, when the server's key does not open it.
	PrivateKey string `json:"private_key,omitempty"`
}

// Addr is host:port.
func (j *Jump) Addr() string {
	return net.JoinHostPort(j.Host, strconv.Itoa(j.Port))
}

// ParseJump reads OpenSSH's ProxyJump form, [user@]host[:port]. A chain of bastions is refused.
func ParseJump(s string) (*Jump, error) {
	s = strings.TrimSpace(s)
	if strings.Contains(s, ",") {
		return nil, errs.Config("jump %q is a chain of bastions; Dockflow goes through one", s)
	}
	s = strings.TrimPrefix(s, "ssh://")
	j := &Jump{}
	if user, rest, ok := strings.Cut(s, "@"); ok {
		if user == "" {
			return nil, errs.Config("jump %q has an empty user", s)
		}
		j.User, s = user, rest
	}
	j.Host = s
	if h, p, err := net.SplitHostPort(s); err == nil {
		port, err := strconv.Atoi(p)
		if err != nil || port < 1 || port > 65535 {
			return nil, errs.Config("jump %q: %q is not a valid port", s, p)
		}
		j.Host, j.Port = h, port
	}
	if j.Host == "" || strings.ContainsAny(j.Host, "/ ") {
		return nil, errs.Config("jump %q is not [user@]host[:port]", s)
	}
	return j, nil
}

// ConnString is the decoded connection string.
type ConnString struct {
	V          int      `json:"v"`
	Servers    []Server `json:"servers"`
	PrivateKey string   `json:"private_key,omitempty"`
	Password   string   `json:"password,omitempty"`
}

// ParseConnString decodes a connection string.
func ParseConnString(s string) (*ConnString, error) {
	s = strings.TrimSpace(s)
	raw, err := decodeBase64(s)
	if err != nil {
		return nil, errs.Config("the connection string is not valid base64").
			WithHint("print it again with `dockflow server connection`")
	}
	// unknown fields are ignored: a string printed by a newer CLI works with an older one, as a
	// CI that pins its version holds it (cli-v1.md, Connection string)
	var c ConnString
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, errs.Config("the connection string is not valid").WithCause(err).
			WithHint("print it again with `dockflow server connection`")
	}
	if c.V != 2 && c.V != 3 {
		return nil, errs.Config("connection string version %d is not supported", c.V).
			WithHint("print a new one with `dockflow server connection`")
	}
	if len(c.Servers) == 0 {
		return nil, errs.Config("the connection string holds no server")
	}
	if len(c.Servers) > 1 {
		return nil, errs.Config("the connection string holds %d servers; this version deploys an environment to one server", len(c.Servers)).
			WithHint("several servers per environment come later (ADR-0023)")
	}
	if c.PrivateKey == "" && c.Password == "" {
		return nil, errs.Config("the connection string holds neither a private key nor a password")
	}
	for i := range c.Servers {
		if err := c.Servers[i].normalise(); err != nil {
			return nil, err
		}
	}
	return &c, nil
}

// Encode returns the connection string: version 3 when a server is reached through a bastion,
// which a CLI that does not know jump refuses rather than connecting directly; 2 otherwise.
func (c ConnString) Encode() string {
	c.V = 2
	for _, s := range c.Servers {
		if s.Jump != nil {
			c.V = 3
		}
	}
	b, _ := json.Marshal(c)
	return base64.StdEncoding.EncodeToString(b)
}

func (s *Server) normalise() error {
	if s.Host == "" {
		return errs.Config("a server of the connection string has no host")
	}
	if s.Name == "" {
		s.Name = "main"
	}
	if !domain.ServerName.MatchString(s.Name) {
		return errs.Config("server name %q must match %s", s.Name, domain.ServerName)
	}
	if s.Port == 0 {
		s.Port = 22
	}
	if s.User == "" {
		s.User = "dockflow"
	}
	if j := s.Jump; j != nil {
		if j.Host == "" {
			return errs.Config("the jump of server %s has no host", s.Name)
		}
		if j.Port == 0 {
			j.Port = 22
		}
		if j.User == "" {
			j.User = s.User
		}
	}
	return nil
}

func decodeBase64(s string) ([]byte, error) {
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if b, err := enc.DecodeString(s); err == nil {
			return b, nil
		}
	}
	return nil, errs.Config("not base64")
}
