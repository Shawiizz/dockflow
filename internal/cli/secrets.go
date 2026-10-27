package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"
	"go.yaml.in/yaml/v3"
	"golang.org/x/term"

	"github.com/Shawiizz/dockflow/internal/agent"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/project"
	"github.com/Shawiizz/dockflow/internal/secrets"
	"github.com/Shawiizz/dockflow/internal/sopsfile"
)

var secretKey = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)

// secretsCmd is `dockflow secrets` (ADR-0012): what the environment sees, and its SOPS file.
func (a *app) secretsCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "secrets", Short: "An environment's secrets, and its SOPS file"}

	cmd.AddCommand(&cobra.Command{
		Use:   "list [<env>]",
		Short: "Keys and where each comes from, never values",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			store, _, _, err := a.secretStore(envArg(args))
			if err != nil {
				return err
			}
			type row struct {
				Key    string `json:"key"`
				Source string `json:"source"`
			}
			rows := []row{}
			for _, k := range store.Keys() {
				src, _ := store.Source(k)
				rows = append(rows, row{k, src})
			}
			if a.json {
				return json.NewEncoder(a.stdout).Encode(rows)
			}
			w := tabwriter.NewWriter(a.stdout, 0, 4, 2, ' ', 0)
			fmt.Fprintln(w, "KEY\tSOURCE")
			for _, r := range rows {
				fmt.Fprintf(w, "%s\t%s\n", r.Key, r.Source)
			}
			return w.Flush()
		},
	})

	var recipients []string
	set := &cobra.Command{
		Use:   "set [<env>] <KEY>",
		Short: "Set a secret in the environment's SOPS file; the value is read from stdin",
		Args:  cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			env, key := "", args[0]
			if len(args) == 2 {
				env, key = args[0], args[1]
			}
			if !secretKey.MatchString(key) {
				return errs.Usage("%q is not a secret key: it must match %s", key, secretKey)
			}
			value, err := a.readSecretValue(key)
			if err != nil {
				return err
			}
			return a.changeSecretsFile(env, recipients, func(keys []string, values map[string]string) ([]string, error) {
				if _, ok := values[key]; !ok {
					keys = append(keys, key)
				}
				values[key] = value
				return keys, nil
			})
		},
	}
	set.Flags().StringSliceVar(&recipients, "age", nil, "for a new file: the age recipients to encrypt for (default: .sops.yaml's creation_rules)")
	cmd.AddCommand(set)

	edit := &cobra.Command{
		Use:   "edit [<env>]",
		Short: "Edit the environment's SOPS file in $EDITOR, decrypted in a temporary file",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.changeSecretsFile(envArg(args), recipients, a.editSecrets)
		},
	}
	edit.Flags().StringSliceVar(&recipients, "age", nil, "for a new file: the age recipients to encrypt for (default: .sops.yaml's creation_rules)")
	cmd.AddCommand(edit)

	cmd.AddCommand(&cobra.Command{
		Use:   "revoke [<env>] <name>",
		Short: "Remove from the server every file of a Compose secret that the current release does not use",
		Args:  cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			env, name := "", args[0]
			if len(args) == 2 {
				env, name = args[0], args[1]
			}
			s, err := a.attach(cmd.Context(), env)
			if err != nil {
				return err
			}
			defer s.Close()
			req := s.request(agent.OpRevoke)
			req.Name = name
			res, err := s.runAgent(cmd.Context(), req)
			if err != nil {
				return err
			}
			var out struct {
				Removed []string `json:"removed"`
			}
			if len(res.Results) > 0 {
				_ = json.Unmarshal(res.Results[len(res.Results)-1], &out)
			}
			if !a.json {
				fmt.Fprintf(a.stdout, "✓ %d old files of %s removed\n", len(out.Removed), name)
			}
			return nil
		},
	})
	return cmd
}

// secretStore reads the environment's secrets without loading Compose, so a missing secret can
// still be listed.
func (a *app) secretStore(env string) (*secrets.Store, string, string, error) {
	raw, name, err := project.Read(a.dir, env)
	if err != nil {
		return nil, "", "", err
	}
	store, err := secrets.Load(name, raw.Dir, os.Environ())
	if err != nil {
		return nil, "", "", err
	}
	file := raw.SecretsFile(name)
	if file != "" {
		values, err := project.ReadSecretsFile(raw.Dir, file, os.Environ())
		if err != nil {
			return nil, "", "", err
		}
		store.AddFile(file, values)
	}
	a.emitter.Masker().Add(store.Values()...)
	return store, name, file, nil
}

// readSecretValue reads a value from stdin: without echo on a terminal, else all of it, minus
// one final newline.
func (a *app) readSecretValue(key string) (string, error) {
	if isTerminal(a.stdin) {
		fmt.Fprintf(a.stderr, "%s: ", key)
		b, err := term.ReadPassword(int(a.stdin.Fd()))
		fmt.Fprintln(a.stderr)
		if err != nil {
			return "", errs.Usage("cannot read the value: %v", err)
		}
		return string(b), nil
	}
	b, err := io.ReadAll(a.stdin)
	if err != nil {
		return "", errs.Usage("cannot read the value: %v", err)
	}
	return strings.TrimSuffix(strings.TrimSuffix(string(b), "\n"), "\r"), nil
}

// changeSecretsFile decrypts the environment's SOPS file (or starts a new one), lets change
// edit its keys and values, and encrypts it again for the same recipients.
func (a *app) changeSecretsFile(env string, recipients []string, change func([]string, map[string]string) ([]string, error)) error {
	raw, name, err := project.Read(a.dir, env)
	if err != nil {
		return err
	}
	file := raw.SecretsFile(name)
	if file == "" {
		file = filepath.Join("secrets", name+".sops.yaml")
	}
	path := filepath.Join(raw.Dir, file)
	keys, values := []string{}, map[string]string{}
	if data, err := os.ReadFile(path); err == nil {
		ids, err := sopsfile.Identities(os.Getenv)
		if err != nil {
			return errs.Config("the age key: %v", err)
		}
		f, err := sopsfile.Decrypt(data, ids)
		if err != nil {
			return errs.Newf("secrets.file", errs.ExitConfig, "cannot decrypt %s: %v", file, err)
		}
		keys, values, recipients = f.Keys, f.Values, f.Recipients
	} else if len(recipients) == 0 {
		if recipients, err = creationRecipients(raw.Dir, file); err != nil {
			return err
		}
	}
	a.emitter.Masker().Add(mapValues(values)...)
	if keys, err = change(keys, values); err != nil {
		return err
	}
	data, err := sopsfile.Encrypt(keys, values, recipients, timeNow())
	if err != nil {
		return errs.Config("cannot encrypt %s: %v", file, err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return errs.Usage("cannot create %s: %v", filepath.Dir(file), err)
	}
	// encrypted: it belongs in git, reviewed like the rest of the project
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return errs.Usage("cannot write %s: %v", file, err)
	}
	if !a.json {
		fmt.Fprintf(a.stdout, "✓ %s: %d secrets, encrypted for %d recipients\n", file, len(keys), len(recipients))
	}
	return nil
}

// editSecrets opens the values, as YAML, in the user's editor.
func (a *app) editSecrets(keys []string, values map[string]string) ([]string, error) {
	dir, err := os.MkdirTemp("", "dockflow-secrets-")
	if err != nil {
		return nil, errs.Internal("temporary directory: %v", err)
	}
	defer os.RemoveAll(dir)
	root := &yaml.Node{Kind: yaml.MappingNode}
	for _, k := range keys {
		root.Content = append(root.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: k},
			&yaml.Node{Kind: yaml.ScalarNode, Value: values[k], Tag: "!!str"})
	}
	b, _ := yaml.Marshal(root)
	if len(keys) == 0 {
		b = []byte("# KEY: value, one per line\n")
	}
	path := filepath.Join(dir, "secrets.yaml")
	if err := os.WriteFile(path, b, 0o600); err != nil {
		return nil, errs.Internal("write %s: %v", path, err)
	}
	editor := os.Getenv("VISUAL")
	if editor == "" {
		editor = os.Getenv("EDITOR")
	}
	if editor == "" {
		editor = "vi"
	}
	c := exec.Command("sh", "-c", editor+` "$1"`, "editor", path)
	c.Stdin, c.Stdout, c.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := c.Run(); err != nil {
		return nil, errs.Usage("the editor failed: %v", err)
	}
	b, err = os.ReadFile(path)
	if err != nil {
		return nil, errs.Internal("read %s: %v", path, err)
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(b, &doc); err != nil {
		return nil, errs.Usage("the secrets are not valid YAML: %v", err)
	}
	for k := range values {
		delete(values, k)
	}
	keys = keys[:0]
	if len(doc.Content) == 1 && doc.Content[0].Kind == yaml.MappingNode {
		m := doc.Content[0]
		for i := 0; i+1 < len(m.Content); i += 2 {
			k, v := m.Content[i].Value, m.Content[i+1]
			if !secretKey.MatchString(k) || v.Kind != yaml.ScalarNode {
				return nil, errs.Usage("%q: secrets are KEY: value, with keys matching %s", k, secretKey)
			}
			keys = append(keys, k)
			values[k] = v.Value
		}
	}
	return keys, nil
}

// creationRecipients reads the age recipients .sops.yaml gives a new file, as sops does.
func creationRecipients(dir, file string) ([]string, error) {
	b, err := os.ReadFile(filepath.Join(dir, ".sops.yaml"))
	if err != nil {
		return nil, errs.Usage("%s does not exist, and there is no age recipient to create it for", file).
			WithHint("give one with --age age1…, or list them in .sops.yaml's creation_rules")
	}
	var cfg struct {
		CreationRules []struct {
			PathRegex string `yaml:"path_regex"`
			Age       any    `yaml:"age"`
		} `yaml:"creation_rules"`
	}
	if err := yaml.Unmarshal(b, &cfg); err != nil {
		return nil, errs.Config(".sops.yaml is not valid: %v", err)
	}
	for _, r := range cfg.CreationRules {
		if r.PathRegex != "" {
			if ok, _ := regexp.MatchString(r.PathRegex, filepath.ToSlash(file)); !ok {
				continue
			}
		}
		var out []string
		switch v := r.Age.(type) {
		case string:
			for _, s := range strings.Split(v, ",") {
				if s = strings.TrimSpace(s); s != "" {
					out = append(out, s)
				}
			}
		case []any:
			for _, s := range v {
				out = append(out, fmt.Sprint(s))
			}
		}
		if len(out) > 0 {
			return out, nil
		}
	}
	return nil, errs.Usage("no creation rule of .sops.yaml gives %s an age recipient", file).
		WithHint("give one with --age age1…")
}

func mapValues(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for _, v := range m {
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}
