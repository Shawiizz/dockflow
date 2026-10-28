// Package secrets reads an environment's secrets (ADR-0012): process variables prefixed with
// the environment's name, the JSON object in DOCKFLOW_SECRETS, the local .env.dockflow file, and
// the environment's SOPS file. For environment production, a key X resolves to PRODUCTION_X,
// then X, in each source in turn.
package secrets

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/Shawiizz/dockflow/internal/errs"
)

// LocalFile is the gitignored file of local secrets, at the project root.
const LocalFile = ".env.dockflow"

// source is one place secrets come from.
type source struct {
	name   string
	values map[string]string
}

// Store holds the secrets of one environment.
type Store struct {
	prefix  string // "PRODUCTION_"
	sources []source
}

// Load reads the secrets of env. environ is the process environment (os.Environ()).
func Load(env, projectDir string, environ []string) (*Store, error) {
	s := &Store{prefix: strings.ToUpper(env) + "_"}

	process := map[string]string{}
	var jsonSecrets string
	for _, kv := range environ {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		if k == "DOCKFLOW_SECRETS" {
			jsonSecrets = v
			continue
		}
		// only the environment's own variables: PATH, HOME and the rest are never read
		if strings.HasPrefix(k, s.prefix) {
			process[k] = v
		}
	}
	if jsonSecrets != "" {
		var m map[string]any
		if err := json.Unmarshal([]byte(jsonSecrets), &m); err != nil {
			return nil, errs.Config("DOCKFLOW_SECRETS is not a JSON object").WithCause(err).
				WithHint(`a JSON object of strings, such as {"DB_PASSWORD": "..."}`)
		}
		for k, v := range m {
			if str, ok := v.(string); ok {
				process[k] = str
			}
		}
	}
	s.sources = append(s.sources, source{name: "CI", values: process})

	local := filepath.Join(projectDir, LocalFile)
	if _, err := os.Stat(local); err == nil {
		values, err := ReadDotenv(local)
		if err != nil {
			return nil, err
		}
		s.sources = append(s.sources, source{name: LocalFile, values: values})
	}
	return s, nil
}

// AddFile adds a source of lower priority than the others: the SOPS file, named by its path.
func (s *Store) AddFile(name string, values map[string]string) {
	s.sources = append(s.sources, source{name: name, values: values})
}

// FromMap returns a store over fixed values, for tests.
func FromMap(env string, values map[string]string) *Store {
	return &Store{prefix: strings.ToUpper(env) + "_", sources: []source{{name: "test", values: values}}}
}

// Lookup returns the secret key, scoped first.
func (s *Store) Lookup(key string) (string, bool) {
	v, _, ok := s.lookup(key)
	return v, ok
}

// Source tells where a key comes from, for `secrets list`.
func (s *Store) Source(key string) (string, bool) {
	_, src, ok := s.lookup(key)
	return src, ok
}

func (s *Store) lookup(key string) (string, string, bool) {
	for _, src := range s.sources {
		if v, ok := src.values[s.prefix+key]; ok {
			return v, src.name, true
		}
		if v, ok := src.values[key]; ok {
			return v, src.name, true
		}
	}
	return "", "", false
}

// Keys returns every key the environment can see, unscoped (PRODUCTION_X appears as X), sorted.
func (s *Store) Keys() []string {
	seen := map[string]bool{}
	for _, src := range s.sources {
		for k := range src.values {
			k = strings.TrimPrefix(k, s.prefix)
			if k != "" {
				seen[k] = true
			}
		}
	}
	keys := make([]string, 0, len(seen))
	for k := range seen {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// Values returns every secret value, for masking.
func (s *Store) Values() []string {
	var out []string
	for _, src := range s.sources {
		for _, v := range src.values {
			out = append(out, v)
		}
	}
	return out
}

// ReadDotenv reads a KEY=value file. Values are taken literally: no variable expansion, so a
// password containing $ survives. Single or double quotes around a value are removed, and
// double-quoted values understand \n, \" and \\.
func ReadDotenv(path string) (map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, errs.Config("cannot read %s", path).WithCause(err)
	}
	defer f.Close()
	out := map[string]string{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	n := 0
	for sc.Scan() {
		n++
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			return nil, errs.Config("%s:%d: expected KEY=value", filepath.Base(path), n)
		}
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		switch {
		case len(v) >= 2 && v[0] == '\'' && v[len(v)-1] == '\'':
			v = v[1 : len(v)-1]
		case len(v) >= 2 && v[0] == '"' && v[len(v)-1] == '"':
			v = unescape(v[1 : len(v)-1])
		default:
			if i := strings.Index(v, " #"); i >= 0 {
				v = strings.TrimSpace(v[:i])
			}
		}
		out[k] = v
	}
	if err := sc.Err(); err != nil {
		return nil, errs.Config("cannot read %s", path).WithCause(err)
	}
	return out, nil
}

func unescape(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) {
			i++
			switch s[i] {
			case 'n':
				b.WriteByte('\n')
			case 't':
				b.WriteByte('\t')
			default:
				b.WriteByte(s[i])
			}
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// Describe is a one-line summary of the sources, for diagnostics.
func (s *Store) Describe() string {
	names := make([]string, len(s.sources))
	for i, src := range s.sources {
		names[i] = fmt.Sprintf("%s (%d)", src.name, len(src.values))
	}
	return strings.Join(names, ", ")
}
