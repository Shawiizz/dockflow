// Package ignore matches paths against .dockerignore-style patterns: globs, ** for any number of
// directories, and ! to re-include. The last matching pattern wins.
package ignore

import (
	"bufio"
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Patterns is an ordered list of patterns.
type Patterns struct {
	list []pattern
}

type pattern struct {
	segments []string
	negate   bool
}

// New reads patterns from lines.
func New(lines []string) *Patterns {
	p := &Patterns{}
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		pt := pattern{}
		if strings.HasPrefix(line, "!") {
			pt.negate = true
			line = strings.TrimSpace(line[1:])
		}
		line = path.Clean(strings.TrimPrefix(filepath.ToSlash(line), "/"))
		if line == "." {
			continue
		}
		pt.segments = strings.Split(line, "/")
		p.list = append(p.list, pt)
	}
	return p
}

// File reads the .dockerignore of dir; none means no pattern.
func File(dir string) (*Patterns, error) {
	f, err := os.Open(filepath.Join(dir, ".dockerignore"))
	if errors.Is(err, fs.ErrNotExist) {
		return &Patterns{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var lines []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		lines = append(lines, sc.Text())
	}
	return New(lines), sc.Err()
}

// HasExceptions tells whether a pattern re-includes paths, so an excluded directory may still
// hold included files.
func (p *Patterns) HasExceptions() bool {
	for _, pt := range p.list {
		if pt.negate {
			return true
		}
	}
	return false
}

// Excludes tells whether rel, a slash-separated relative path, is excluded. A pattern matching a
// directory excludes everything below it.
func (p *Patterns) Excludes(rel string) bool {
	segs := strings.Split(rel, "/")
	excluded := false
	for _, pt := range p.list {
		if matchPrefix(pt.segments, segs) {
			excluded = !pt.negate
		}
	}
	return excluded
}

func matchPrefix(pattern, segs []string) bool {
	for n := 1; n <= len(segs); n++ {
		if match(pattern, segs[:n]) {
			return true
		}
	}
	return false
}

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
