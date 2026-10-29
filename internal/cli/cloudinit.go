package cli

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"go.yaml.in/yaml/v3"
	"golang.org/x/crypto/ssh"

	"github.com/Shawiizz/dockflow/internal/connection"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/provision"
)

// cloudConfig is the part of cloud-init's user-data server cloud-init writes.
type cloudConfig struct {
	SSHDeleteKeys bool              `yaml:"ssh_deletekeys"`
	SSHGenKeys    []string          `yaml:"ssh_genkeytypes"`
	SSHKeys       map[string]string `yaml:"ssh_keys"`
	WriteFiles    []cloudFile       `yaml:"write_files"`
	RunCmd        [][]string        `yaml:"runcmd"`
}

type cloudFile struct {
	Path        string `yaml:"path"`
	Permissions string `yaml:"permissions"`
	Content     string `yaml:"content"`
}

// cloudInitCmd is `dockflow server cloud-init` (ADR-0013): the user-data of a server that is
// provisioned on its first boot. The server's host key is generated here, so the connection
// string pins it before the server exists; the deploy key is generated here too, and only its
// public part goes into the user-data.
func (a *app) cloudInitCmd() *cobra.Command {
	var pf provisionFlags
	var output string
	cmd := &cobra.Command{
		Use:   "cloud-init --host <address> [flags]",
		Short: "Print cloud-init user-data that prepares a new server on its first boot, and its connection string",
		Long: "Prints the user-data to give a new server (DigitalOcean, Hetzner, Scaleway, AWS…): on its first boot, it " +
			"installs Docker and creates the deploy user with a key generated here, as server init does (with --harden-ssh, it also hardens SSH). " +
			"The server's SSH host key is generated here too, so the connection string, printed after, pins it.\n\n" +
			"The user-data holds the server's private host key, never the deploy key: keep it as you would the server's " +
			"disk. Once the server is up, install the switch, the registry and the watchdog with `dockflow server init <env>`.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if pf.host == "" {
				return errs.Usage("--host is required: the address or domain name the CI will reach the server at").
					WithHint("reserve the address first (a floating or elastic IP), or use a domain name you point at it")
			}
			port := pf.port
			if port == 0 {
				port = 22
			}
			key, err := pf.deployKeyFor(pf.host)
			if err != nil {
				return err
			}
			pub, priv, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				return errs.Internal("generate the host key: %v", err)
			}
			block, err := ssh.MarshalPrivateKey(priv, "")
			if err != nil {
				return errs.Internal("encode the host key: %v", err)
			}
			hostPub, _ := ssh.NewPublicKey(pub)
			opts := pf.options(key, "root")
			opts.CloudInit = true
			script, err := provision.Script(opts)
			if err != nil {
				return err
			}
			cfg := cloudConfig{
				SSHDeleteKeys: true,
				SSHGenKeys:    []string{},
				SSHKeys: map[string]string{
					"ed25519_private": string(pem.EncodeToMemory(block)),
					"ed25519_public":  strings.TrimSpace(string(ssh.MarshalAuthorizedKey(hostPub))),
				},
				WriteFiles: []cloudFile{{Path: "/root/dockflow-provision.sh", Permissions: "0700", Content: script}},
				RunCmd:     [][]string{{"sh", "/root/dockflow-provision.sh"}, {"rm", "-f", "/root/dockflow-provision.sh"}},
			}
			body, err := yaml.Marshal(cfg)
			if err != nil {
				return errs.Internal("encode the user-data: %v", err)
			}
			userData := "#cloud-config\n" + string(body)
			name := pf.name
			if name == "" {
				name = "main"
			}
			server := connection.Server{Name: name, Host: pf.host, Port: port, User: pf.user, HostKey: ssh.FingerprintSHA256(hostPub)}
			cs := connection.ConnString{Servers: []connection.Server{server}, PrivateKey: key.PrivatePEM}.Encode()
			if output != "" {
				// it holds the server's private host key: 0600, an existing file's mode included
				if err := writePrivate(output, []byte(userData)); err != nil {
					return errs.Usage("cannot write %s: %v", output, err)
				}
			}
			if a.json {
				doc := map[string]any{"connection": cs, "host": pf.host, "port": port, "host_key": server.HostKey, "user": pf.user}
				if output == "" {
					doc["user_data"] = userData
				}
				return json.NewEncoder(a.stdout).Encode(doc)
			}
			if output == "" {
				fmt.Fprintf(a.stdout, "%s", userData)
			}
			fmt.Fprintf(a.stderr, "\nGive the user-data above to the new server")
			if output != "" {
				fmt.Fprintf(a.stderr, " (written to %s)", output)
			}
			fmt.Fprintf(a.stderr, ". Its host key is %s.\n", server.HostKey)
			fmt.Fprintf(a.stderr, "Store the connection string below as the <ENV>_CONNECTION secret of your CI, or in .env.dockflow.\n")
			fmt.Fprintf(a.stderr, "Once its first boot has finished (a few minutes; cloud-init status --wait on the server tells), install the\n")
			fmt.Fprintf(a.stderr, "switch, the registry and the watchdog: dockflow server init <env>.\n\n%s\n", cs)
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&pf.host, "host", "", "the address or domain name the CI reaches the server at (required)")
	f.IntVar(&pf.port, "port", 0, "the SSH port the CI uses (default 22)")
	f.StringVar(&pf.user, "user", "", "the deploy user to create (default dockflow)")
	f.StringVar(&pf.deployKey, "deploy-key", "", "a private key to use for the deploy user instead of generating one")
	f.StringVar(&pf.name, "name", "", "the server's name in the connection string (default main)")
	f.BoolVar(&pf.skipDocker, "skip-docker-install", false, "for an image that has Docker: refuse to install it")
	f.BoolVar(&pf.noFilter, "no-port-filter", false, "do not install the published-port filter's boot unit")
	f.BoolVar(&pf.hardenSSH, "harden-ssh", false, "write an SSH drop-in that refuses passwords and lets root in by key only, once root has a key")
	f.BoolVar(&pf.nginx, "nginx", false, "install nginx, with the sudo rules of the nginx plugin")
	f.StringSliceVar(&pf.from, "from", nil, "the source addresses or CIDRs the deploy key accepts")
	f.StringVarP(&output, "output", "o", "", "write the user-data to this file (mode 600) instead of the standard output")
	return cmd
}

// writePrivate writes a file only its owner can read: an existing file is made 0600 before it
// gets the content.
func writePrivate(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
