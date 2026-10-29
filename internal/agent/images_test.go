package agent

import (
	"context"
	"errors"
	"io"
	"testing"

	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/events"
)

// pullEngine pulls every image, or none when offline.
type pullEngine struct {
	engine.Engine
	offline bool
}

func (e pullEngine) ResolveImage(_ context.Context, ref, _ string, _ *engine.RegistryAuth) (string, error) {
	if e.offline {
		return "", errors.New("no network")
	}
	return ref, nil
}

func TestUpgradeMovesToThePinnedImages(t *testing.T) {
	const old = "caddy:2@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	for _, c := range []struct {
		name, image, given, want string
		upgrade, offline         bool
	}{
		{"init keeps the server's image", old, "", old, false, false},
		{"the floating tag of earlier versions", old, "", DefaultSwitchImage, true, false},
		{"the same repository, named in full", "docker.io/library/caddy:2.8.4@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "", DefaultSwitchImage, true, false},
		{"already pinned", DefaultSwitchImage, "", DefaultSwitchImage, true, false},
		{"another image is pulled again by its tag", "example.com/caddy:2@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "", "example.com/caddy:2#pull", true, false},
		{"an image the run names", "example.com/caddy:2", "example.com/caddy:2", "example.com/caddy:2", true, false},
		{"offline, the server's image stays", old, "", old, true, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			r := &runner{Deps: Deps{Engine: pullEngine{offline: c.offline}}, req: Request{Upgrade: c.upgrade},
				ev: events.NewEmitter("run", events.NewJSONSink(io.Discard), nil)}
			if got := r.upgraded(context.Background(), c.image, c.given, DefaultSwitchImage); got != c.want {
				t.Fatalf("upgraded(%s) = %s, want %s", c.image, got, c.want)
			}
		})
	}
}
