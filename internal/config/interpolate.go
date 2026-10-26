package config

import (
	"errors"
	"regexp"

	"github.com/compose-spec/compose-go/v2/template"
)

// Lookup returns the value of a variable.
type Lookup func(name string) (string, bool)

var varName = regexp.MustCompile(`^\$\{?([_a-zA-Z][_a-zA-Z0-9]*)`)

// MissingVariableError is a variable used without a value and without a default.
type MissingVariableError struct {
	Name string
}

func (e *MissingVariableError) Error() string {
	return "variable " + e.Name + " is not defined"
}

// Substitute is Compose's interpolation (${VAR}, ${VAR:-default}, ${VAR:?message}, $$), except
// that a variable with no value and no default is an error rather than an empty string. It is
// the substitution function handed to compose-go.
func Substitute(s string, mapping template.Mapping) (string, error) {
	return template.SubstituteWithOptions(s, mapping,
		template.WithoutLogging,
		template.WithReplacementFunction(func(sub string, m template.Mapping, cfg *template.Config) (string, error) {
			value, applied, err := template.DefaultReplacementAppliedFunc(sub, m, cfg)
			if err != nil {
				return "", err
			}
			if !applied {
				name := sub
				if g := varName.FindStringSubmatch(sub); g != nil {
					name = g[1]
				}
				return "", &MissingVariableError{Name: name}
			}
			return value, nil
		}))
}

// Interpolate substitutes variables in s with lookup.
func Interpolate(s string, lookup Lookup) (string, error) {
	out, err := Substitute(s, template.Mapping(lookup))
	if err != nil {
		var missing *MissingVariableError
		if errors.As(err, &missing) {
			return "", missing
		}
		var required *template.MissingRequiredError
		if errors.As(err, &required) {
			return "", required
		}
		return "", err
	}
	return out, nil
}
