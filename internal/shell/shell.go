// Package shell builds the shell scripts of provisioning (ADR-0013). A script is fixed shell
// text written in the code, and values enter it only as quoted variable assignments at its top,
// so no value, wherever it comes from, is ever read as shell syntax.
package shell

import (
	"regexp"
	"strings"
)

// Script is a POSIX sh script.
type Script struct {
	vars []string
	body []string
}

var varName = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)

// Quote returns s as one single-quoted shell word.
func Quote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// Set assigns value to the variable name at the top of the script. The body reads it as
// "$NAME", always within double quotes.
func (s *Script) Set(name, value string) *Script {
	if !varName.MatchString(name) {
		panic("shell: invalid variable name " + name)
	}
	s.vars = append(s.vars, name+"="+Quote(value))
	return s
}

// Body appends shell text. It must be a constant of the code: values go through Set.
func (s *Script) Body(text string) *Script {
	s.body = append(s.body, text)
	return s
}

// String is the script: strict mode, the assignments, then the body.
func (s *Script) String() string {
	var b strings.Builder
	b.WriteString("set -eu\n")
	for _, v := range s.vars {
		b.WriteString(v + "\n")
	}
	for _, t := range s.body {
		b.WriteString(t)
		if !strings.HasSuffix(t, "\n") {
			b.WriteString("\n")
		}
	}
	return b.String()
}
