package connection

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/Shawiizz/dockflow/internal/errs"
)

// HostConfig is what ~/.ssh/config says about a host (ADR-0013): only the keywords Dockflow
// uses. Empty fields are not set there.
type HostConfig struct {
	HostName      string
	Port          int
	User          string
	IdentityFiles []string
	// ProxyJump is the bastion, [user@]host[:port], or none
	ProxyJump string
	// ProxyCommand is not supported: Dockflow refuses a host that has one rather than connecting
	// directly
	ProxyCommand string
}

// ReadSSHConfig reads the user's ~/.ssh/config for host, as OpenSSH does: the first value of
// each keyword wins, Host patterns may use * and ? and be negated with !, Include is followed,
// and Match blocks are skipped. A missing file says nothing.
func ReadSSHConfig(host string) HostConfig {
	home, err := os.UserHomeDir()
	if err != nil {
		return HostConfig{}
	}
	var c HostConfig
	readSSHConfig(filepath.Join(home, ".ssh", "config"), filepath.Join(home, ".ssh"), host, &c, 0)
	expand := func(s string) string {
		if s == "~" || strings.HasPrefix(s, "~/") {
			s = filepath.Join(home, s[1:])
		}
		return strings.ReplaceAll(s, "%h", firstNonEmpty(c.HostName, host))
	}
	for i, f := range c.IdentityFiles {
		c.IdentityFiles[i] = expand(f)
	}
	c.HostName = strings.ReplaceAll(c.HostName, "%h", host)
	return c
}

func readSSHConfig(path, dir, host string, c *HostConfig, depth int) {
	f, err := os.Open(path)
	if err != nil || depth > 8 {
		return
	}
	defer f.Close()
	applies := true // keywords before the first Host apply to every host
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		key, value := sshConfigLine(sc.Text())
		if key == "" {
			continue
		}
		switch key {
		case "host":
			applies = hostMatches(host, strings.Fields(value))
			continue
		case "match":
			// conditions Dockflow does not evaluate: the block is skipped
			applies = false
			continue
		}
		if !applies {
			continue
		}
		switch key {
		case "include":
			for _, pattern := range strings.Fields(value) {
				if strings.HasPrefix(pattern, "~/") {
					pattern = filepath.Join(filepath.Dir(dir), pattern[2:])
				} else if !filepath.IsAbs(pattern) {
					pattern = filepath.Join(dir, pattern)
				}
				matches, _ := filepath.Glob(pattern)
				for _, m := range matches {
					readSSHConfig(m, dir, host, c, depth+1)
				}
			}
		case "hostname":
			if c.HostName == "" {
				c.HostName = value
			}
		case "port":
			if p, err := strconv.Atoi(value); err == nil && c.Port == 0 {
				c.Port = p
			}
		case "user":
			if c.User == "" {
				c.User = value
			}
		case "proxyjump":
			if c.ProxyJump == "" {
				c.ProxyJump = value
			}
		case "proxycommand":
			if c.ProxyCommand == "" {
				c.ProxyCommand = value
			}
		case "identityfile":
			// every IdentityFile adds a key, in order
			c.IdentityFiles = append(c.IdentityFiles, strings.Trim(value, `"`))
		}
	}
}

// sshConfigLine splits "Keyword value" or "Keyword=value", lowercasing the keyword.
func sshConfigLine(line string) (string, string) {
	line = strings.TrimSpace(line)
	if line == "" || strings.HasPrefix(line, "#") {
		return "", ""
	}
	i := strings.IndexAny(line, " \t=")
	if i < 0 {
		return strings.ToLower(line), ""
	}
	key := strings.ToLower(line[:i])
	value := strings.TrimLeft(strings.TrimSpace(line[i:]), "=")
	return key, strings.TrimSpace(value)
}

// hostMatches applies a Host line: one pattern must match, and no negated one.
func hostMatches(host string, patterns []string) bool {
	matched := false
	for _, p := range patterns {
		if neg, ok := strings.CutPrefix(p, "!"); ok {
			if globMatch(neg, host) {
				return false
			}
			continue
		}
		if globMatch(p, host) {
			matched = true
		}
	}
	return matched
}

// globMatch matches ssh_config patterns: * any run of characters, ? one character.
func globMatch(pattern, s string) bool {
	m, err := filepath.Match(pattern, s)
	if err == nil {
		return m
	}
	return pattern == s
}

// UseSSHConfig completes t from ~/.ssh/config, where t.Server.Host may be an alias: its
// HostName, and its Port and User unless the caller set them; its IdentityFiles are tried after
// ssh-agent. Its ProxyJump is the bastion unless the caller set one, and the bastion, an alias
// too, is completed the same way.
func (t *Target) UseSSHConfig(portSet, userSet bool) error {
	alias := t.Server.Host
	c := ReadSSHConfig(alias)
	if err := noProxyCommand(alias, c); err != nil {
		return err
	}
	if c.HostName != "" {
		t.Server.Host = c.HostName
	}
	if !portSet && c.Port != 0 {
		t.Server.Port = c.Port
	}
	if !userSet && c.User != "" {
		t.Server.User = c.User
	}
	t.IdentityFiles = c.IdentityFiles
	if t.Server.Jump == nil && c.ProxyJump != "" && !strings.EqualFold(c.ProxyJump, "none") {
		j, err := ParseJump(c.ProxyJump)
		if err != nil {
			return errs.Config("ProxyJump of %s in ~/.ssh/config: %s", alias, err.Error())
		}
		t.Server.Jump = j
	}
	j := t.Server.Jump
	if j == nil {
		return nil
	}
	jc := ReadSSHConfig(j.Host)
	if err := noProxyCommand(j.Host, jc); err != nil {
		return err
	}
	if jc.ProxyJump != "" && !strings.EqualFold(jc.ProxyJump, "none") {
		return errs.Config("the bastion %s has its own ProxyJump in ~/.ssh/config; Dockflow goes through one bastion", j.Host)
	}
	if jc.HostName != "" {
		j.Host = jc.HostName
	}
	if j.Port == 0 {
		j.Port = jc.Port
	}
	if j.User == "" {
		j.User = jc.User
	}
	t.JumpIdentityFiles = jc.IdentityFiles
	return nil
}

// noProxyCommand refuses a host that ~/.ssh/config reaches through a ProxyCommand, which Dockflow
// does not run: connecting directly would fail with a misleading error, or reach another host.
func noProxyCommand(host string, c HostConfig) error {
	if c.ProxyCommand == "" || strings.EqualFold(c.ProxyCommand, "none") {
		return nil
	}
	return errs.Config("%s has a ProxyCommand in ~/.ssh/config, which Dockflow does not run", host).
		WithHint("reach it through a bastion with ProxyJump, or server.jump in dockflow.yml")
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
