package render

import (
	"bufio"
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/Shawiizz/dockflow/internal/errs"
)

// dockerignore is a .dockerignore: patterns in order, the last match wins, `!` re-includes.
type dockerignore struct {
	patterns []ignorePattern
}

type ignorePattern struct {
	segments []string
	negate   bool
}

func readDockerignore(dir string) (*dockerignore, error) {
	f, err := os.Open(filepath.Join(dir, ".dockerignore"))
	if errors.Is(err, fs.ErrNotExist) {
		return &dockerignore{}, nil
	}
	if err != nil {
		return nil, errs.Internal("read %s/.dockerignore: %v", dir, err)
	}
	defer f.Close()
	di := &dockerignore{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		p := ignorePattern{}
		if strings.HasPrefix(line, "!") {
			p.negate = true
			line = strings.TrimSpace(line[1:])
		}
		line = path.Clean(strings.TrimPrefix(filepath.ToSlash(line), "/"))
		if line == "." {
			continue
		}
		p.segments = strings.Split(line, "/")
		di.patterns = append(di.patterns, p)
	}
	return di, sc.Err()
}

func (d *dockerignore) hasExceptions() bool {
	for _, p := range d.patterns {
		if p.negate {
			return true
		}
	}
	return false
}

// excludes tells whether rel, a slash-separated path relative to the context, is excluded. A
// pattern matching a directory excludes everything below it.
func (d *dockerignore) excludes(rel string, _ bool) bool {
	segs := strings.Split(rel, "/")
	excluded := false
	for _, p := range d.patterns {
		if matchPrefix(p.segments, segs) {
			excluded = !p.negate
		}
	}
	return excluded
}

// matchPrefix reports whether pattern matches path or one of its parent directories.
func matchPrefix(pattern, segs []string) bool {
	for n := 1; n <= len(segs); n++ {
		if match(pattern, segs[:n]) {
			return true
		}
	}
	return false
}

// match matches path segments against pattern segments, where ** matches any number of
// segments and the others use filepath.Match.
func match(pattern, segs []string) bool {
	if len(pattern) == 0 {
		return len(segs) == 0
	}
	if pattern[0] == "**" {
		for i := 0; i <= len(segs); i++ {
			if match(pattern[1:], segs[i:]) {
				return true
			}
		}
		return false
	}
	if len(segs) == 0 {
		return false
	}
	ok, err := path.Match(pattern[0], segs[0])
	if err != nil || !ok {
		return false
	}
	return match(pattern[1:], segs[1:])
}
