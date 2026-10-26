package connection

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// HostConfig is what ~/.ssh/config says about a host (ADR-0013): only the keywords Dockflow
// uses. Empty fields are not set there.
type HostConfig struct {
	HostName      string
	Port          int
	User          string
	IdentityFiles []string
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
// ssh-agent.
func (t *Target) UseSSHConfig(portSet, userSet bool) {
	c := ReadSSHConfig(t.Server.Host)
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
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
