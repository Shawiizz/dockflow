package agent

import (
	"os/exec"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

// Passwords the credential files must carry unchanged.
var hardPasswords = []string{
	"plain",
	`dou"ble`,
	`back\slash`,
	`trailing\`,
	`\"`,
	"sin'gle",
	"dol$lar $(id) `id`",
	"with space",
	" leading and trailing ",
	"new\nline",
	"trailing newline\n",
	"tab\tcr\r",
	"#not a comment",
	`a"#b`,
	"ctl\x01\x1f\x7f",
	"pässwörd ☃",
	"nel\u0085ls ps ",
	"%s %d \\n",
}

// shells runs a script with each shell present: the containers' sh is dash or bash, bash in a
// UTF-8 locale reads characters, not bytes.
func shells(t *testing.T) map[string]func(script string, env ...string) string {
	t.Helper()
	out := map[string]func(string, ...string) string{}
	add := func(name, bin string, locale string) {
		path, err := exec.LookPath(bin)
		if err != nil {
			return
		}
		out[name] = func(script string, env ...string) string {
			t.Helper()
			cmd := exec.Command(path, "-c", script, "sh", "")
			cmd.Env = append([]string{"PATH=/usr/bin:/bin", "LANG=" + locale, "LC_ALL=" + locale}, env...)
			b, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("%s: %v\n%s", name, err, b)
			}
			return string(b)
		}
	}
	add("sh", "sh", "C")
	add("dash", "dash", "C")
	add("bash", "bash", "C")
	add("bash-utf8", "bash", "C.UTF-8")
	if len(out) == 0 {
		t.Skip("no shell")
	}
	return out
}

// The MySQL option file holds any password: read as the client reads it, it is the same.
func TestMySQLOptionFileCarriesAnyPassword(t *testing.T) {
	for name, run := range shells(t) {
		for _, pw := range hardPasswords {
			file := run(mysqlCredentials+`cat "$cnf"`, "MYSQL_ROOT_PASSWORD="+pw)
			opts := readOptionFile(t, file)
			if opts["password"] != pw || opts["user"] != "root" {
				t.Errorf("%s: password %q: read back %q, user %q\n%s", name, pw, opts["password"], opts["user"], file)
			}
		}
	}
}

// The mongo tools' configuration holds any password: parsed as YAML, it is the same.
func TestMongoConfigCarriesAnyPassword(t *testing.T) {
	for name, run := range shells(t) {
		for _, pw := range hardPasswords {
			file := run(mongoCredentials+`cat "$cnf"`, "MONGO_INITDB_ROOT_USERNAME=root", "MONGO_INITDB_ROOT_PASSWORD="+pw)
			var cfg map[string]string
			if err := yaml.Unmarshal([]byte(file), &cfg); err != nil {
				t.Errorf("%s: password %q: %v\n%s", name, pw, err, file)
				continue
			}
			if cfg["password"] != pw || len(cfg) != 1 {
				t.Errorf("%s: password %q: read back %q\n%s", name, pw, cfg["password"], file)
			}
		}
	}
}

// readOptionFile reads the [client] group of a MySQL option file the way the client library does
// (mysys/my_default.cc): an end comment cut outside quotes, spaces trimmed, matching quotes
// removed, then the escape sequences.
func readOptionFile(t *testing.T, file string) map[string]string {
	t.Helper()
	opts := map[string]string{}
	for _, line := range strings.Split(strings.TrimSuffix(file, "\n"), "\n") {
		line = strings.TrimSpace(cutEndComment(line))
		if line == "" || line == "[client]" {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			t.Fatalf("not an option: %q in\n%s", line, file)
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[0] == value[len(value)-1] {
			value = value[1 : len(value)-1]
		}
		var b strings.Builder
		for i := 0; i < len(value); i++ {
			if value[i] != '\\' || i == len(value)-1 {
				b.WriteByte(value[i])
				continue
			}
			i++
			switch value[i] {
			case 'n':
				b.WriteByte('\n')
			case 't':
				b.WriteByte('\t')
			case 'r':
				b.WriteByte('\r')
			case 'b':
				b.WriteByte('\b')
			case 's':
				b.WriteByte(' ')
			case '"', '\'', '\\':
				b.WriteByte(value[i])
			default:
				b.WriteByte('\\')
				b.WriteByte(value[i])
			}
		}
		opts[strings.TrimSpace(key)] = b.String()
	}
	return opts
}

// cutEndComment is remove_end_comment of mysys: a # outside quotes starts a comment.
func cutEndComment(line string) string {
	var quote byte
	escape := false
	for i := 0; i < len(line); i++ {
		c := line[i]
		if (c == '\'' || c == '"') && !escape {
			switch quote {
			case 0:
				quote = c
			case c:
				quote = 0
			}
		}
		if quote == 0 && c == '#' {
			return line[:i]
		}
		escape = quote != 0 && c == '\\' && !escape
	}
	return line
}
