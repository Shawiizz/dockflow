package compose

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"

	"github.com/compose-spec/compose-go/v2/types"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
)

// ExtensionKey is the Compose extension Dockflow reads on services.
const ExtensionKey = "x-dockflow"

// Extension is x-dockflow on a service (docs/design/spec/config-v1.md). Keys of the spec that
// arrive in later milestones are refused with a clear message.
type Extension struct {
	Routes   []RouteExt  `json:"routes"`
	Rollout  *RolloutExt `json:"rollout"`
	Health   *HealthExt  `json:"health"`
	Stateful bool        `json:"stateful"`
	Run      string      `json:"run"`
	Backup   *BackupExt  `json:"backup"`
}

// RouteExt is one route.
type RouteExt struct {
	Domains     []string `json:"domains"`
	Path        string   `json:"path"`
	Port        int      `json:"port"`
	TLS         *bool    `json:"tls"`
	StripPrefix bool     `json:"strip_prefix"`
	RouteOptionsExt
}

// RouteOptionsExt are the options of a route (ADR-0011).
type RouteOptionsExt struct {
	Headers  map[string]string `json:"headers"`
	Encode   []string          `json:"encode"`
	MaxBody  SizeExt           `json:"max_body"`
	Timeouts *struct {
		Read  string `json:"read"`
		Write string `json:"write"`
		Dial  string `json:"dial"`
	} `json:"timeouts"`
	Auth *struct {
		User     string `json:"user"`
		Password string `json:"password"`
	} `json:"auth"`
	Caddy string `json:"caddy"`
	// ErrorPages maps statuses, "502,503", to a route of dockflow.yml or an inline body.
	ErrorPages map[string]ErrorPageExt `json:"error_pages"`
}

// ErrorPageExt is a page of error_pages.
type ErrorPageExt struct {
	Route string `json:"route" yaml:"route"`
	Body  string `json:"body" yaml:"body"`
}

// SizeExt is a size, written as a number of bytes or a string: 25MB, 512k.
type SizeExt string

func (s *SizeExt) UnmarshalJSON(b []byte) error {
	var n json.Number
	if err := json.Unmarshal(b, &n); err == nil {
		*s = SizeExt(n.String())
		return nil
	}
	var str string
	if err := json.Unmarshal(b, &str); err != nil {
		return err
	}
	*s = SizeExt(str)
	return nil
}

// StatusExt is a status or a range of statuses, written as a number or a string: 200, "200-399".
type StatusExt string

func (s *StatusExt) UnmarshalJSON(b []byte) error {
	var n json.Number
	if err := json.Unmarshal(b, &n); err == nil {
		*s = StatusExt(n.String())
		return nil
	}
	var str string
	if err := json.Unmarshal(b, &str); err != nil {
		return err
	}
	*s = StatusExt(str)
	return nil
}

// RolloutExt is x-dockflow.rollout.
type RolloutExt struct {
	Strategy string `json:"strategy"`
	Drain    string `json:"drain"`
}

// HTTPExt is x-dockflow.health.http: an internal check, before the switch.
type HTTPExt struct {
	Path     string    `json:"path"`
	Port     int       `json:"port"`
	Status   StatusExt `json:"status"` // 200, or a range 200-399
	Timeout  string    `json:"timeout"`
	Retries  *int      `json:"retries"`
	Interval string    `json:"interval"`
}

// HealthExt is x-dockflow.health.
type HealthExt struct {
	Grace        string   `json:"grace"`
	RestartAfter string   `json:"restart_after"`
	HTTP         *HTTPExt `json:"http"`
}

func readExtension(s types.ServiceConfig) (Extension, error) {
	var x Extension
	raw, ok := s.Extensions[ExtensionKey]
	if !ok || raw == nil {
		return x, nil
	}
	b, err := json.Marshal(raw)
	if err != nil {
		return x, errs.Config("service %s: %s cannot be read", s.Name, ExtensionKey).WithCause(err)
	}
	// encoding/json matches keys regardless of case: the keys are checked as written first
	if key := wrongCase(raw, reflect.TypeOf(x)); key != "" {
		return x, errs.Config("service %s: %s: unknown key %q", s.Name, ExtensionKey, key).
			WithHint("keys are lowercase, as listed in docs/design/spec/config-v1.md")
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&x); err != nil {
		msg := strings.TrimPrefix(err.Error(), "json: ")
		return x, errs.Config("service %s: %s: %s", s.Name, ExtensionKey, msg).
			WithHint("its keys are listed in docs/design/spec/config-v1.md")
	}
	return x, nil
}

// wrongCase returns the first key of v that matches a field of t only regardless of case, such
// as Stateful for stateful. Values that decode themselves are not looked into.
func wrongCase(v any, t reflect.Type) string {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if reflect.PointerTo(t).Implements(reflect.TypeOf((*json.Unmarshaler)(nil)).Elem()) {
		return ""
	}
	switch t.Kind() {
	case reflect.Slice:
		if list, ok := v.([]any); ok {
			for _, item := range list {
				if k := wrongCase(item, t.Elem()); k != "" {
					return k
				}
			}
		}
	case reflect.Struct:
		m, ok := v.(map[string]any)
		if !ok {
			return ""
		}
		for key, val := range m {
			f, exact := fieldOf(t, key)
			if f == nil {
				continue // unknown keys are refused by the decoder
			}
			if !exact {
				return key
			}
			if k := wrongCase(val, f.Type); k != "" {
				return k
			}
		}
	}
	return ""
}

// fieldOf returns the field of t whose JSON name is key, and whether the case matches too.
func fieldOf(t reflect.Type, key string) (*reflect.StructField, bool) {
	var folded *reflect.StructField
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
		if name == "" {
			name = f.Name
		}
		if name == key {
			return &f, true
		}
		if strings.EqualFold(name, key) {
			folded = &f
		}
	}
	return folded, false
}

// BackupExt is x-dockflow.backup (ADR-0015).
type BackupExt struct {
	Type           string       `json:"type"`
	Database       string       `json:"database"`
	DumpOptions    string       `json:"dump_options"`
	RestoreOptions string       `json:"restore_options"`
	Volumes        []string     `json:"volumes"`
	Quiesce        QuiesceExt   `json:"quiesce"`
	Dump           []string     `json:"dump"`
	Restore        []string     `json:"restore"`
	Keep           *domain.Keep `json:"keep"`
}

// QuiesceExt is backup.quiesce: stop or none, or { exec: { pre, post } }.
type QuiesceExt struct {
	Mode      string
	Pre, Post []string
}

func (q *QuiesceExt) UnmarshalJSON(b []byte) error {
	if err := json.Unmarshal(b, &q.Mode); err == nil {
		return nil
	}
	var v struct {
		Exec *struct {
			Pre  []string `json:"pre"`
			Post []string `json:"post"`
		} `json:"exec"`
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&v); err != nil || v.Exec == nil {
		return fmt.Errorf("quiesce is stop, none, or { exec: { pre: [...], post: [...] } }")
	}
	q.Mode, q.Pre, q.Post = domain.QuiesceExec, v.Exec.Pre, v.Exec.Post
	return nil
}
