package state

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/Shawiizz/dockflow/internal/proxy"
)

// switchRoutes is switch/routes/<stack>.json: the routes the switch serves for one app
// environment, as last applied.
type switchRoutes struct {
	Schema int           `json:"schema"`
	Routes []proxy.Route `json:"routes"`
}

func (s *Store) routesDir() string { return filepath.Join(s.root, "switch", "routes") }

// SwitchRoutes reads the routes the switch serves, for every app environment, ordered by stack.
func (s *Store) SwitchRoutes() (map[string][]proxy.Route, error) {
	entries, err := os.ReadDir(s.routesDir())
	if errors.Is(err, fs.ErrNotExist) {
		return map[string][]proxy.Route{}, nil
	}
	if err != nil {
		return nil, ioErr("list the switch routes", err)
	}
	out := map[string][]proxy.Route{}
	for _, e := range entries {
		stack, ok := strings.CutSuffix(e.Name(), ".json")
		if !ok {
			continue
		}
		var v switchRoutes
		if _, err := s.readJSON(filepath.Join(s.routesDir(), e.Name()), &v); err != nil {
			return nil, err
		}
		out[stack] = v.Routes
	}
	return out, nil
}

// SetSwitchRoutes records the routes of stack; none removes its file.
func (s *Store) SetSwitchRoutes(stack string, routes []proxy.Route) error {
	path := filepath.Join(s.routesDir(), stack+".json")
	if len(routes) == 0 {
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return ioErr("remove the routes of "+stack, err)
		}
		return nil
	}
	if err := os.MkdirAll(s.routesDir(), 0o700); err != nil {
		return ioErr("create the switch directory", err)
	}
	return s.writeJSON(path, switchRoutes{Schema: Schema, Routes: routes}, false)
}

// AllRoutes flattens the routes of every stack, in stack order.
func AllRoutes(m map[string][]proxy.Route) []proxy.Route {
	stacks := make([]string, 0, len(m))
	for k := range m {
		stacks = append(stacks, k)
	}
	sort.Strings(stacks)
	var out []proxy.Route
	for _, k := range stacks {
		out = append(out, m[k]...)
	}
	return out
}
