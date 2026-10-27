package plugin

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/Shawiizz/dockflow/internal/config"
	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/testutil"
)

var values = Values{
	Public: map[string]string{"DOCKFLOW_APP": "shop", "DOCKFLOW_ENV": "production", "DOCKFLOW_STACK": "shop-production"},
	All:    map[string]string{"DOCKFLOW_APP": "shop", "DOCKFLOW_ENV": "production", "DOCKFLOW_STACK": "shop-production", "TOKEN": "t0ken"},
}

// expansion is what golden files hold: the uploads, their bundles' files, and the hooks.
type expansion struct {
	Uploads []upload      `json:"uploads"`
	Files   []string      `json:"files"`
	Hooks   []domain.Hook `json:"hooks"`
}

type upload struct {
	Src, Dest, Mode, Plugin string
}

func expand(t *testing.T, uses ...config.PluginUse) (*Expanded, expansion) {
	t.Helper()
	e, err := Expand("testdata/project", uses, values)
	if err != nil {
		t.Fatal(err)
	}
	var x expansion
	seen := map[string]bool{}
	for _, u := range e.Uploads {
		x.Uploads = append(x.Uploads, upload{u.Src, u.Dest, u.Mode, u.Plugin})
		if seen[u.Bundle.Name] {
			continue
		}
		seen[u.Bundle.Name] = true
		for name, f := range u.Bundle.Files {
			x.Files = append(x.Files, u.Bundle.Name+"/"+name+" "+f.Mode.String())
		}
	}
	sort.Strings(x.Files)
	x.Hooks = e.Hooks
	return e, x
}

func file(t *testing.T, e *Expanded, plugin, name string) string {
	t.Helper()
	for _, u := range e.Uploads {
		if u.Plugin == plugin {
			if f, ok := u.Bundle.Files[name]; ok {
				return string(f.Data)
			}
		}
	}
	t.Fatalf("no file %s in plugin %s", name, plugin)
	return ""
}

func TestNginxDefault(t *testing.T) {
	e, x := expand(t, config.PluginUse{Use: "nginx", With: map[string]any{"domain": []any{"shop.example.com", "www.shop.example.com"}}})
	testutil.Golden(t, "nginx-default", x)
	testutil.GoldenText(t, "nginx-default.conf", file(t, e, "nginx", "vhost.conf"))
}

func TestNginxTLSCloudflare(t *testing.T) {
	e, x := expand(t, config.PluginUse{Use: "nginx", ID: "api", With: map[string]any{
		"domain": "api.example.com", "port": 3013, "tls": true, "cloudflare": "true", "max_body_size": "100m"}})
	testutil.Golden(t, "nginx-tls-cloudflare", x)
	testutil.GoldenText(t, "nginx-tls-cloudflare.conf", file(t, e, "api", "vhost.conf"))
}

// a second app behind Cloudflare, on the same nginx as the one above, without IPv6
func TestNginxCloudflare(t *testing.T) {
	e, _ := expand(t, config.PluginUse{Use: "nginx", With: map[string]any{"domain": "www.example.com", "cloudflare": true, "ipv6": false}})
	testutil.GoldenText(t, "nginx-cloudflare.conf", file(t, e, "nginx", "vhost.conf"))
}

func TestNginxOwnTemplate(t *testing.T) {
	e, _ := expand(t, config.PluginUse{Use: "nginx", With: map[string]any{"domain": "api.example.com", "template": "deploy/api.conf"}})
	testutil.GoldenText(t, "nginx-own.conf", file(t, e, "nginx", "vhost.conf"))
}

func TestSystemd(t *testing.T) {
	e, x := expand(t, config.PluginUse{Use: "systemd", With: map[string]any{"unit": "deploy/rclone.service"}})
	testutil.Golden(t, "systemd", x)
	if got := file(t, e, "systemd", "unit"); !strings.Contains(got, "rclone mount for shop-production") {
		t.Fatalf("the unit is rendered: %q", got)
	}
}

func TestProjectPlugin(t *testing.T) {
	e, x := expand(t,
		config.PluginUse{Use: "./plugins/hello", With: map[string]any{"greeting": "hi", "names": []any{"ann", "bob"}}},
		config.PluginUse{Use: "./plugins/hello", ID: "loud", With: map[string]any{"greeting": "hi", "loud": true}},
	)
	testutil.Golden(t, "project", x)
	if got, want := file(t, e, "hello", "files/hello.txt"), "hi, ann from production (t0ken)\nhi, bob from production (t0ken)\n"; got != want {
		t.Fatalf("hello.txt = %q, want %q", got, want)
	}
	if got, want := file(t, e, "loud", "files/hello.txt"), "HI, world from production (t0ken)\n"; got != want {
		t.Fatalf("loud hello.txt = %q, want %q", got, want)
	}
}

func TestErrors(t *testing.T) {
	cases := []struct {
		name string
		uses []config.PluginUse
		want string
	}{
		{"unknown built-in", []config.PluginUse{{Use: "apache"}}, `no built-in plugin "apache"`},
		{"unknown input", []config.PluginUse{{Use: "nginx", With: map[string]any{"domain": "a.com", "domians": "b.com"}}}, "unknown input domians"},
		{"required input", []config.PluginUse{{Use: "nginx"}}, "the input domain is required"},
		{"boolean", []config.PluginUse{{Use: "nginx", With: map[string]any{"domain": "a.com", "tls": "yes"}}}, "input tls: yes is not true or false"},
		{"bad id", []config.PluginUse{{Use: "nginx", ID: "Api", With: map[string]any{"domain": "a.com"}}}, `the id "Api"`},
		{"same id", []config.PluginUse{{Use: "nginx", With: map[string]any{"domain": "a.com"}}, {Use: "nginx", With: map[string]any{"domain": "b.com"}}}, "two uses have the id nginx"},
		{"outside", []config.PluginUse{{Use: "../elsewhere"}}, "must be a directory inside the project"},
		{"missing file", []config.PluginUse{{Use: "systemd", With: map[string]any{"unit": "deploy/none.service"}}}, "deploy/none.service is not a file of the project"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := Expand("testdata/project", c.uses, values)
			e, ok := errs.As(err)
			if !ok || e.Exit != errs.ExitConfig || !strings.Contains(e.Message, c.want) {
				t.Fatalf("want a config error with %q, got %v", c.want, err)
			}
		})
	}
}

func TestManifestErrors(t *testing.T) {
	cases := map[string]string{
		"script":     "hooks:\n  before_deploy:\n    - script: x.sh\n",
		"if_changed": "hooks:\n  after_deploy:\n    - host: true\n      if_changed: /nowhere\n",
		"phase":      "uploads:\n  - src: f\n    dest: /srv/f\nhooks:\n  before_deploy:\n    - host: true\n      if_changed: /srv/f\n",
		"unknown":    "upload:\n  - src: f\n",
	}
	want := map[string]string{
		"script":     "has no script",
		"if_changed": "is the destination of none of the plugin's uploads",
		"phase":      "if_changed belongs to after_deploy hooks",
		"unknown":    "field upload not found",
	}
	for name, manifest := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.MkdirAll(filepath.Join(dir, "p"), 0o755); err != nil {
				t.Fatal(err)
			}
			for name, content := range map[string]string{"plugin.yml": manifest, "f": "x"} {
				if err := os.WriteFile(filepath.Join(dir, "p", name), []byte(content), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			_, err := Expand(dir, []config.PluginUse{{Use: "./p"}}, values)
			if err == nil || !strings.Contains(err.Error(), want[name]) {
				t.Fatalf("want an error with %q, got %v", want[name], err)
			}
		})
	}
}
