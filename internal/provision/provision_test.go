package provision

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

// Contract test: the script in real distributions, with a stand-in docker command (installing
// Docker itself needs a VM; the real-server tests of M3 cover it). Skipped without Docker.
func TestScriptProvisionsTwiceTheSame(t *testing.T) {
	if err := exec.Command("docker", "version").Run(); err != nil {
		if os.Getenv("DOCKFLOW_CONTRACT") != "" {
			t.Fatal("docker is required")
		}
		t.Skip("no docker")
	}
	key, err := NewKey("dockflow@production")
	if err != nil {
		t.Fatal(err)
	}
	script, err := Script(Options{User: DefaultUser, AuthorizedKey: key.Authorized})
	if err != nil {
		t.Fatal(err)
	}
	// a docker that reports version 27.5.1
	fake := "mkdir -p /usr/local/bin && printf '#!/bin/sh\\necho 27.5.1\\n' >/usr/local/bin/docker && chmod +x /usr/local/bin/docker\n"
	check := `
sh /tmp/provision.sh >/tmp/first
sh /tmp/provision.sh >/tmp/second
cat /tmp/first; echo ---; cat /tmp/second; echo ---
id -nG dockflow; echo ---
cat /home/dockflow/.ssh/authorized_keys; echo ---
stat -c '%a %U' /home/dockflow/.ssh /home/dockflow/.ssh/authorized_keys
`
	for _, image := range []string{"mirror.gcr.io/library/debian:12", "mirror.gcr.io/library/alpine:3"} {
		t.Run(image, func(t *testing.T) {
			cmd := exec.Command("docker", "run", "--rm", "-i", image, "sh", "-c", "cat >/tmp/provision.sh\n"+fake+check)
			cmd.Stdin = strings.NewReader(script)
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("%v:\n%s", err, out)
			}
			parts := strings.Split(string(out), "---\n")
			if len(parts) < 5 {
				t.Fatalf("unexpected output:\n%s", out)
			}
			first, second, groups, keys, perms := parts[0], parts[1], parts[2], parts[3], parts[4]
			for _, want := range []string{"creating the user dockflow", "adding dockflow to the docker group", "installing the deploy key", "docker: 27.5.1"} {
				if !strings.Contains(first, want) {
					t.Fatalf("first run: no %q:\n%s", want, first)
				}
			}
			if strings.Contains(second, "step:") {
				t.Fatalf("a second run must change nothing:\n%s", second)
			}
			if !strings.Contains(groups, "docker") {
				t.Fatalf("dockflow must be in the docker group: %s", groups)
			}
			if strings.TrimSpace(keys) != key.Authorized {
				t.Fatalf("authorized_keys:\n%s\nwant the key once:\n%s", keys, key.Authorized)
			}
			if !strings.Contains(perms, "700 dockflow") || !strings.Contains(perms, "600 dockflow") {
				t.Fatalf("permissions: %s", perms)
			}
		})
	}
}

func TestScriptRefusesMissingOrOldDocker(t *testing.T) {
	if err := exec.Command("docker", "version").Run(); err != nil {
		t.Skip("no docker")
	}
	key, _ := NewKey("x")
	script, _ := Script(Options{User: DefaultUser, AuthorizedKey: key.Authorized})
	cases := map[string]int{
		"": exitNoDocker,
		"printf '#!/bin/sh\\necho 24.0.7\\n' >/usr/local/bin/docker && chmod +x /usr/local/bin/docker; ": exitDockerTooOld,
	}
	for setup, want := range cases {
		cmd := exec.Command("docker", "run", "--rm", "-i", "mirror.gcr.io/library/alpine:3", "sh", "-c", "cat >/tmp/p.sh; mkdir -p /usr/local/bin; "+setup+"sh /tmp/p.sh")
		cmd.Stdin = strings.NewReader(script)
		err := cmd.Run()
		ee, ok := err.(*exec.ExitError)
		if !ok || ee.ExitCode() != want {
			t.Fatalf("setup %q: got %v, want exit %d", setup, err, want)
		}
	}
}

func TestUserNameIsChecked(t *testing.T) {
	if _, err := Script(Options{User: "root; rm -rf /", AuthorizedKey: "ssh-ed25519 AAAA"}); err == nil {
		t.Fatal("an invalid user name must be refused")
	}
}
