package agent

import (
	"context"
	"errors"
	"testing"

	"github.com/Shawiizz/dockflow/internal/engine"
)

type imageEngine struct {
	engine.Engine
	images map[string]engine.Image
}

func (e imageEngine) InspectImage(_ context.Context, ref string) (engine.Image, error) {
	if img, ok := e.images[ref]; ok {
		return img, nil
	}
	return engine.Image{}, errors.New("no such image")
}

// An image pinned to its bare ID, as the agent's built on the server, shows its tag.
func TestReadableImage(t *testing.T) {
	id := "sha256:61bd5de43c38f43cf6ec52ad10d5f2eb95bcb01bb784b653f7cf213105a7f453"
	eng := imageEngine{images: map[string]engine.Image{id: {ID: id, Tags: []string{"dockflow/agent:1.0.0-alpha.6"}}}}
	cases := map[string]string{
		id:                             "dockflow/agent:1.0.0-alpha.6 (sha256:61bd5de43c38)",
		"caddy:2.11.7@sha256:5e5286cb": "caddy:2.11.7@sha256:5e5286cb",
		"sha256:0000000000000000000000000000000000000000000000000000000000000000": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
	}
	for in, want := range cases {
		if got := readableImage(context.Background(), eng, in); got != want {
			t.Errorf("readableImage(%s) = %s, want %s", in, got, want)
		}
	}
}
