package cli

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/Shawiizz/dockflow/internal/compose"
	"github.com/Shawiizz/dockflow/internal/config"
	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/version"
)

// initCmd is `dockflow init`: the files of a new project, and its CI workflow.
func (a *app) initCmd() *cobra.Command {
	var name, domainName, ci string
	var force bool
	cmd := &cobra.Command{
		Use:   "init",
		Short: "Write dockflow.yml, a compose.yml when there is none, and a CI workflow",
		Long: "Writes dockflow.yml with a production environment, a compose.yml when the directory has no Compose " +
			"file (a service built from the Dockerfile when there is one, nginx otherwise, with a route to --domain), " +
			"adds .env.dockflow to .gitignore and, with --ci, a workflow that builds on branches and deploys on tags.\n\n" +
			"On a terminal, it asks for what the flags do not give. It never overwrites a file without --force.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			dir, err := filepath.Abs(a.dir)
			if err != nil {
				return errs.Usage("%s: %v", a.dir, err)
			}
			if name == "" {
				name = appNameFrom(filepath.Base(dir))
			}
			if a.interactive() {
				in := bufio.NewReader(a.stdin)
				if !cmd.Flags().Changed("app") {
					name = a.askLine(in, "App name", name)
				}
				if !cmd.Flags().Changed("domain") {
					domainName = a.askLine(in, "Domain of the app", defaultDomain(domainName, name))
				}
				if !cmd.Flags().Changed("ci") {
					ci = a.askLine(in, "CI workflow (github, gitlab or none)", "none")
				}
			}
			domainName = defaultDomain(domainName, name)
			if !domain.AppName.MatchString(name) {
				return errs.Usage("app %q must match %s (at most 24 characters)", name, domain.AppName).
					WithHint("give one with --app")
			}
			files, err := scaffold(dir, name, domainName, ci)
			if err != nil {
				return err
			}
			if !force {
				for _, f := range files {
					if f.append {
						continue
					}
					if _, err := os.Stat(filepath.Join(dir, f.path)); err == nil {
						return errs.New("init.exists", errs.ExitUsage, f.path+" exists already").
							WithHint("run it with --force to replace it")
					}
				}
			}
			var written []string
			for _, f := range files {
				changed, err := f.write(dir)
				if err != nil {
					return err
				}
				if changed {
					written = append(written, f.path)
				}
			}
			a.printResult(map[string]any{"app": name, "files": written}, func(w io.Writer) {
				for _, f := range written {
					fmt.Fprintf(w, "✓ %s\n", f)
				}
				fmt.Fprintf(w, "\nNext: prepare a server with `dockflow server init root@<host>`, then store the connection string it\n")
				fmt.Fprintf(w, "prints as PRODUCTION_CONNECTION (in .env.dockflow, or as a secret of your CI), and run `dockflow deploy`.\n")
			})
			return nil
		},
	}
	cmd.Flags().StringVar(&name, "app", "", "the app's name (default: the directory's)")
	cmd.Flags().StringVar(&domainName, "domain", "", "the domain the app is served at (default <app>.example.com)")
	cmd.Flags().StringVar(&ci, "ci", "", "write a CI workflow: github or gitlab")
	cmd.Flags().BoolVar(&force, "force", false, "replace the files that exist")
	return cmd
}

func (a *app) askLine(in *bufio.Reader, question, def string) string {
	fmt.Fprintf(a.stdout, "%s [%s]: ", question, def)
	line, _ := in.ReadString('\n')
	if line = strings.TrimSpace(line); line != "" {
		return line
	}
	return def
}

func defaultDomain(d, app string) string {
	if d != "" {
		return d
	}
	return app + ".example.com"
}

var notAppChar = regexp.MustCompile(`[^a-z0-9-]+`)

// appNameFrom makes an app name of a directory's name, or returns it as it is when it cannot.
func appNameFrom(dir string) string {
	n := strings.Trim(notAppChar.ReplaceAllString(strings.ToLower(dir), "-"), "-")
	if len(n) > 24 {
		n = strings.TrimRight(n[:24], "-")
	}
	if domain.AppName.MatchString(n) {
		return n
	}
	return dir
}

// scaffoldFile is a file init writes; append adds its lines to the file instead, those it lacks.
type scaffoldFile struct {
	path    string
	content string
	append  bool
}

func (f scaffoldFile) write(dir string) (bool, error) {
	path := filepath.Join(dir, f.path)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false, errs.Usage("cannot create %s: %v", filepath.Dir(f.path), err)
	}
	content := f.content
	if f.append {
		old, err := os.ReadFile(path)
		if err != nil && !os.IsNotExist(err) {
			return false, errs.Usage("cannot read %s: %v", f.path, err)
		}
		have := map[string]bool{}
		for _, l := range strings.Split(string(old), "\n") {
			have[strings.TrimSpace(l)] = true
		}
		var add []string
		for _, l := range strings.Split(strings.TrimSpace(f.content), "\n") {
			if !have[l] && !have["/"+l] {
				add = append(add, l)
			}
		}
		if len(add) == 0 {
			return false, nil
		}
		if len(old) > 0 && !bytes.HasSuffix(old, []byte("\n")) {
			old = append(old, '\n')
		}
		content = string(old) + strings.Join(add, "\n") + "\n"
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return false, errs.Usage("cannot write %s: %v", f.path, err)
	}
	return true, nil
}

// scaffold is what init writes in dir.
func scaffold(dir, app, domainName, ci string) ([]scaffoldFile, error) {
	files := []scaffoldFile{{path: config.FileName, content: fmt.Sprintf(`# Dockflow's settings: https://dockflow.shawiizz.dev/reference/dockflow-yml/
# The server comes from the PRODUCTION_CONNECTION secret, printed by dockflow server init.
version: 1
app: %s

environments:
  production:
    vars:
      DOMAIN: %s
`, app, domainName)}}

	hasCompose := false
	for _, f := range compose.DefaultFiles {
		if _, err := os.Stat(filepath.Join(dir, f)); err == nil {
			hasCompose = true
		}
	}
	if !hasCompose {
		files = append(files, scaffoldFile{path: "compose.yml", content: starterCompose(dir)})
	}
	files = append(files, scaffoldFile{path: ".gitignore", content: ".env.dockflow\n", append: true})

	install := "curl -fsSL https://raw.githubusercontent.com/Shawiizz/dockflow/main/install.sh | sh"
	if v := version.Version; v != "dev" {
		install += " -s -- --version " + v
	}
	switch ci {
	case "", "none":
	case "github":
		files = append(files, scaffoldFile{path: ".github/workflows/deploy.yml", content: strings.ReplaceAll(githubWorkflow, "{install}", install)})
	case "gitlab":
		files = append(files, scaffoldFile{path: ".gitlab-ci.yml", content: strings.ReplaceAll(gitlabWorkflow, "{install}", install)})
	default:
		return nil, errs.Usage("--ci %q: github or gitlab", ci).
			WithHint("Jenkins, Buildkite and Bitbucket workflows are in the docs: https://dockflow.shawiizz.dev/guides/ci/")
	}
	return files, nil
}

// starterCompose is a web service built from the Dockerfile, on the port it exposes, or nginx.
func starterCompose(dir string) string {
	if b, err := os.ReadFile(filepath.Join(dir, "Dockerfile")); err == nil {
		port := 80
		for _, l := range strings.Split(string(b), "\n") {
			f := strings.Fields(l)
			if len(f) >= 2 && strings.EqualFold(f[0], "EXPOSE") {
				if p, err := strconv.Atoi(strings.Split(f[1], "/")[0]); err == nil {
					port = p
					break
				}
			}
		}
		return fmt.Sprintf(`services:
  web:
    build: .
    # A healthcheck tells Dockflow when a new container is ready for traffic; without one,
    # a container counts as ready after 10s running. For example:
    # healthcheck:
    #   test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:%[1]d/"]
    #   interval: 5s
    x-dockflow:
      routes:
        - domains: ["${DOMAIN}"]
          port: %[1]d
`, port)
	}
	return `services:
  web:
    image: nginx:1.27-alpine
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1/"]
      interval: 5s
      timeout: 3s
      retries: 3
    x-dockflow:
      routes:
        - domains: ["${DOMAIN}"]
          port: 80
`
}

const githubWorkflow = `# Builds on every branch, deploys on tags: 1.2.0 to production, and backs up
# production every night.
# Add PRODUCTION_CONNECTION, and the secrets your Compose files use, under
# Settings > Secrets and variables > Actions.
name: Deploy

on:
  push:
    branches: ["**"]
    tags: ["*"]
  schedule:
    - cron: "17 3 * * *"
  workflow_dispatch:

jobs:
  build:
    if: github.event_name == 'push' && github.ref_type == 'branch'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install dockflow
        run: {install}
      - name: Build
        run: dockflow build production
        env:
          DOCKFLOW_SECRETS: ${{ toJSON(secrets) }}

  deploy:
    if: github.event_name == 'push' && github.ref_type == 'tag'
    runs-on: ubuntu-latest
    concurrency: deploy
    steps:
      - uses: actions/checkout@v4
      - name: Install dockflow
        run: {install}
      - name: Deploy
        run: dockflow deploy --wait-lock 10m
        env:
          DOCKFLOW_SECRETS: ${{ toJSON(secrets) }}

  # the services that declare x-dockflow.backup, then the server's state
  backup:
    if: github.event_name != 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install dockflow
        run: {install}
      - name: Back up
        run: dockflow backup run production --wait-lock 10m && dockflow backup run production --server
        env:
          DOCKFLOW_SECRETS: ${{ toJSON(secrets) }}
`

const gitlabWorkflow = `# Builds on every branch, deploys on tags: 1.2.0 to production, and backs up
# production when a schedule runs it (Build > Pipeline schedules).
# Add PRODUCTION_CONNECTION, and the secrets your Compose files use, under
# Settings > CI/CD > Variables, masked.
default:
  image: docker:27
  services:
    - docker:27-dind
  before_script:
    - apk add --no-cache curl
    - {install}

variables:
  DOCKER_TLS_CERTDIR: "/certs"

stages: [build, deploy, backup]

build:
  stage: build
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule"
      when: never
    - if: $CI_COMMIT_BRANCH
  script:
    - dockflow build production

deploy:
  stage: deploy
  resource_group: production
  rules:
    - if: $CI_COMMIT_TAG
  script:
    - dockflow deploy --wait-lock 10m

# the services that declare x-dockflow.backup, then the server's state
backup:
  stage: backup
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule"
  script:
    - dockflow backup run production --wait-lock 10m
    - dockflow backup run production --server
`
