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

// Contract test: hardening and --nginx in Debian, with stand-ins for what needs the network or
// systemd (apt-get, dpkg, systemctl, sshd, visudo, nginx), which log their calls.
func TestScriptHardensAndInstallsNginx(t *testing.T) {
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
	restricted := *key
	if err := restricted.Restrict([]string{"203.0.113.0/24"}); err != nil {
		t.Fatal(err)
	}
	first, err := Script(Options{User: DefaultUser, AuthorizedKey: restricted.Authorized, Harden: true, Nginx: true})
	if err != nil {
		t.Fatal(err)
	}
	second, err := Script(Options{User: DefaultUser, AuthorizedKey: restricted.Authorized, Harden: true, Nginx: true})
	if err != nil {
		t.Fatal(err)
	}
	stubs := `set -e
mkdir -p /usr/local/bin /etc/ssh/sshd_config.d /root/.ssh /tmp/pkgs
echo 'Include /etc/ssh/sshd_config.d/*.conf' >/etc/ssh/sshd_config
echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA admin' >/root/.ssh/authorized_keys
stub() { printf '#!/bin/sh\n%s\n' "$2" >/usr/local/bin/$1; chmod +x /usr/local/bin/$1; }
stub docker 'echo 27.5.1'
stub dpkg '[ -e /tmp/pkgs/$2 ]'
stub apt-get 'echo "apt-get $*" >>/tmp/calls; for p in "$@"; do touch /tmp/pkgs/$p; [ "$p" = nginx ] && printf "#!/bin/sh\necho nginx \$*>>/tmp/calls\n" >/usr/local/bin/nginx && chmod +x /usr/local/bin/nginx; done; true'
stub systemctl 'echo "systemctl $*" >>/tmp/calls'
stub sshd '[ "$1" = -T ] && cat /etc/ssh/sshd_config.d/*.conf | grep -v "^#" | awk "{ k = tolower(\$1); if (!(k in seen)) { seen[k] = 1; print k, (\$2 == \"prohibit-password\" ? \"without-password\" : tolower(\$2)) } }"; exit 0'
echo 'PasswordAuthentication yes' >/etc/ssh/sshd_config.d/50-cloud-init.conf
stub visudo 'exit 0'
mkdir -p /etc/nginx/sites-enabled && ln -s /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
`
	check := `
sh /tmp/first.sh >/tmp/out1
sh /tmp/second.sh >/tmp/out2
cat /tmp/out1; echo ---; cat /tmp/out2; echo ---
cat /etc/ssh/sshd_config.d/01-dockflow.conf; echo ---
echo 'PasswordAuthentication yes' >/etc/ssh/sshd_config.d/00-early.conf
sh /tmp/second.sh; echo ---
rm /etc/ssh/sshd_config.d/00-early.conf /etc/ssh/sshd_config.d/01-dockflow.conf /root/.ssh/authorized_keys
sh /tmp/second.sh; ls /etc/ssh/sshd_config.d; echo ---
ls /etc/fail2ban /etc/apt/apt.conf.d/20auto-upgrades 2>&1 || true; echo ---
cat /etc/nginx/conf.d/00-dockflow-default.conf; ls /etc/nginx/sites-enabled; echo ---
cat /etc/sudoers.d/dockflow-nginx; echo ---
cat /home/dockflow/.ssh/authorized_keys; echo ---
cat /tmp/calls
`
	cmd := exec.Command("docker", "run", "--rm", "-i", "mirror.gcr.io/library/debian:12", "sh", "-c",
		"cat >/tmp/both; sed -n '1,/^#END-OF-FIRST$/p' /tmp/both >/tmp/first.sh; sed '1,/^#END-OF-FIRST$/d' /tmp/both >/tmp/second.sh\n"+stubs+check)
	cmd.Stdin = strings.NewReader(first + "\n#END-OF-FIRST\n" + second)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v:\n%s", err, out)
	}
	parts := strings.Split(string(out), "---\n")
	if len(parts) < 10 {
		t.Fatalf("unexpected output:\n%s", out)
	}
	run1, run2, sshd, shadowed, noKey := parts[0], parts[1], parts[2], parts[3], parts[4]
	system, nginx, sudoers, keys, calls := parts[5], parts[6], parts[7], parts[8], parts[9]
	for _, want := range []string{"hardening SSH", "installing nginx", "refusing unknown host names", "allowing dockflow to check and reload nginx"} {
		if !strings.Contains(run1, want) {
			t.Errorf("first run: no %q", want)
		}
	}
	if strings.Contains(run2, "step:") {
		t.Errorf("a second run must change nothing:\n%s", run2)
	}
	if !strings.Contains(sshd, "PasswordAuthentication no") || !strings.Contains(sshd, "PermitRootLogin prohibit-password") {
		t.Errorf("the SSH drop-in, with root's key there:\n%s", sshd)
	}
	// a provider's 50-cloud-init.conf comes after 01-dockflow.conf: no warning then. A file
	// read before it wins, and the run says so
	if strings.Contains(run1, "warning") {
		t.Errorf("01-dockflow.conf comes before the provider's drop-in:\n%s", run1)
	}
	if !strings.Contains(shadowed, "warning: SSH hardening did not take effect: passwordauthentication is yes, not no") {
		t.Errorf("a setting another file sets first must be reported:\n%s", shadowed)
	}
	// root without a key logs in with a password: nothing is written
	if !strings.Contains(noKey, "root has no authorized key") || strings.Contains(noKey, "01-dockflow.conf") {
		t.Errorf("root without a key must not be locked out:\n%s", noKey)
	}
	// the server's administration is not Dockflow's (ADR-0024)
	if strings.Count(system, "No such file") != 2 {
		t.Errorf("no fail2ban, no automatic updates' settings:\n%s", system)
	}
	if !strings.Contains(nginx, "return 444") || !strings.Contains(nginx, "ssl_reject_handshake on") || strings.Contains(nginx, "default\n") {
		t.Errorf("nginx refuses unknown hosts, without the distribution's default site:\n%s", nginx)
	}
	if !strings.Contains(sudoers, "dockflow ALL=(root) NOPASSWD: /usr/local/bin/nginx -t") {
		t.Errorf("sudo rules:\n%s", sudoers)
	}
	if strings.TrimSpace(keys) != restricted.Authorized {
		t.Errorf("the restricted key, once:\n%s", keys)
	}
	if strings.Contains(calls, "fail2ban") || strings.Contains(calls, "unattended-upgrades") {
		t.Errorf("calls:\n%s", calls)
	}
}

// a key installed with other options is replaced, not added again
func TestScriptReplacesTheKeysOptions(t *testing.T) {
	if err := exec.Command("docker", "version").Run(); err != nil {
		t.Skip("no docker")
	}
	key, _ := NewKey("dockflow@production")
	restricted := *key
	restricted.Restrict([]string{"198.51.100.7"})
	a, _ := Script(Options{User: DefaultUser, AuthorizedKey: key.Authorized})
	b, _ := Script(Options{User: DefaultUser, AuthorizedKey: restricted.Authorized})
	cmd := exec.Command("docker", "run", "--rm", "-i", "mirror.gcr.io/library/alpine:3", "sh", "-c",
		"cat >/tmp/both; sed -n '1,/^#END-OF-FIRST$/p' /tmp/both >/tmp/a.sh; sed '1,/^#END-OF-FIRST$/d' /tmp/both >/tmp/b.sh; mkdir -p /usr/local/bin; printf '#!/bin/sh\\necho 27.5.1\\n' >/usr/local/bin/docker; chmod +x /usr/local/bin/docker; sh /tmp/a.sh >/dev/null && sh /tmp/b.sh >/dev/null && cat /home/dockflow/.ssh/authorized_keys")
	cmd.Stdin = strings.NewReader(a + "\n#END-OF-FIRST\n" + b)
	out, err := cmd.CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) != restricted.Authorized {
		t.Fatalf("%v: authorized_keys:\n%s\nwant only:\n%s", err, out, restricted.Authorized)
	}
}
