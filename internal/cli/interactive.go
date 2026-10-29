package cli

import (
	"archive/tar"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
	"golang.org/x/crypto/ssh"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/launcher"
)

// exitWith makes the CLI exit with a command's own exit code (exec, run, ssh).
func exitWith(code int) error {
	if code == 0 {
		return nil
	}
	return &errs.Error{Code: "command.exit", Exit: code, Reported: true}
}

// splitDash separates the arguments before `--` from the command after it.
func splitDash(cmd *cobra.Command, args []string) ([]string, []string) {
	if at := cmd.ArgsLenAtDash(); at >= 0 {
		return args[:at], args[at:]
	}
	return args, nil
}

// envAndService reads [<env>] <service>.
func envAndService(args []string) (string, string, error) {
	switch len(args) {
	case 1:
		return "", args[0], nil
	case 2:
		return args[0], args[1], nil
	}
	return "", "", errs.Usage("name a service: [<env>] <service>")
}

// serviceContainer is a running container of service; with pick, the user chooses one.
func (a *app) serviceContainer(ctx context.Context, s *session, service string, pick bool) (engine.Container, error) {
	cs, err := s.appContainers(ctx, false)
	if err != nil {
		return engine.Container{}, err
	}
	var running []engine.Container
	for _, c := range serving(cs) {
		if c.Service == service && c.State == "running" {
			running = append(running, c)
		}
	}
	if len(running) == 0 {
		return engine.Container{}, errs.Usage("service %s has no running container", service).
			WithHint("check it with `dockflow status`")
	}
	if pick {
		return a.pick(running)
	}
	return running[0], nil
}

func (a *app) execCmd() *cobra.Command {
	var env []string
	var user, workdir string
	var shell, noTTY, pick bool
	cmd := &cobra.Command{
		Use:   "exec [<env>] <service> [-- <command>…]",
		Short: "Run a command in a running container; a shell by default",
		RunE: func(cmd *cobra.Command, args []string) error {
			pos, command := splitDash(cmd, args)
			envName, service, err := envAndService(pos)
			if err != nil {
				return err
			}
			a.quiet()
			ctx := cmd.Context()
			s, err := a.attach(ctx, envName)
			if err != nil {
				return err
			}
			defer s.Close()
			c, err := a.serviceContainer(ctx, s, service, pick)
			if err != nil {
				return err
			}
			if len(command) == 0 {
				command = []string{"sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"}
				if shell {
					command = []string{"sh"}
				}
			}
			tty := !noTTY && isTerminal(a.stdin)
			w, h := terminalSize()
			ex, err := s.engine.Exec(ctx, c.ID, engine.ExecOptions{
				Cmd: command, Env: env, User: user, WorkingDir: workdir, TTY: tty, Stdin: true, Width: w, Height: h,
			})
			if err != nil {
				return err
			}
			defer ex.Close()
			sess := interactive{stdin: ex.Stdin, stdout: ex.Stdout, tty: tty, resize: ex.Resize}
			if !tty {
				sess.stderr = ex.Stderr
			}
			if err := a.interact(ctx, sess); err != nil {
				return err
			}
			code, err := ex.Wait(context.WithoutCancel(ctx))
			if err != nil {
				return err
			}
			return exitWith(code)
		},
	}
	f := cmd.Flags()
	f.StringArrayVarP(&env, "env", "e", nil, "set an environment variable, K=V")
	f.StringVarP(&user, "user", "u", "", "run as this user")
	f.StringVarP(&workdir, "workdir", "w", "", "run in this directory")
	f.BoolVar(&shell, "sh", false, "open sh, not bash")
	f.BoolVarP(&noTTY, "no-tty", "T", false, "no terminal, for scripts")
	f.BoolVar(&pick, "pick", false, "choose the container, when the service has several")
	return cmd
}

func (a *app) runCmd() *cobra.Command {
	var env []string
	cmd := &cobra.Command{
		Use:   "run [<env>] <service> [-e K=V]… -- <command>…",
		Short: "A one-off container with the service's spec, for a console or a script",
		RunE: func(cmd *cobra.Command, args []string) error {
			pos, command := splitDash(cmd, args)
			envName, service, err := envAndService(pos)
			if err != nil {
				return err
			}
			a.quiet()
			ctx := cmd.Context()
			s, err := a.connect(ctx, envName, "")
			if err != nil {
				return err
			}
			defer s.Close()
			svc, ok := s.loaded.App.Service(service)
			if !ok {
				return errs.Usage("no service %s in %s", service, s.loaded.Config.Env)
			}
			spec := svc.Spec
			// the deployed image: a running container's, so nothing is built or pulled
			if c, err := a.serviceContainer(ctx, s, service, false); err == nil {
				spec.Image = c.Image
			} else if spec.Image, err = s.engine.ResolveImage(ctx, spec.Image, "missing", registryAuth(s.loaded)); err != nil {
				return err
			}
			tty := isTerminal(a.stdin)
			if len(command) > 0 {
				spec.Command = command
			}
			spec.Env = append(append([]string(nil), spec.Env...), env...)
			spec.Ports, spec.Restart = nil, "no"
			spec.Tty, spec.StdinOpen, spec.StdinOnce = tty, true, true
			for i := range spec.Networks {
				spec.Networks[i].Aliases = nil
			}
			stack := domain.Stack(s.loaded.Config.App, s.loaded.Config.Env)
			name := fmt.Sprintf("%s-%s-run-%s", stack, service, strings.ToLower(launcher.NewRunID(timeNow())[16:]))
			labels := map[string]string{
				domain.LabelProject: stack, domain.LabelService: service, domain.LabelOneOff: "True",
				domain.LabelKind: domain.KindOneOff, domain.LabelSchema: "1", domain.LabelManagedBy: "true",
			}
			id, err := s.engine.Create(ctx, name, spec, labels)
			if err != nil {
				return err
			}
			defer func() { _ = s.engine.Remove(context.WithoutCancel(ctx), id) }()
			att, err := s.engine.Attach(ctx, id, tty)
			if err != nil {
				return err
			}
			defer att.Close()
			if err := s.engine.Start(ctx, id); err != nil {
				return err
			}
			sess := interactive{stdin: att.Stdin, stdout: att.Stdout, tty: tty,
				resize: func(ctx context.Context, w, h uint) error { return s.engine.Resize(ctx, id, w, h) }}
			if !tty {
				sess.stderr = att.Stderr
			}
			if err := a.interact(ctx, sess); err != nil {
				return err
			}
			code, err := s.engine.Wait(context.WithoutCancel(ctx), id)
			if err != nil {
				return err
			}
			return exitWith(code)
		},
	}
	cmd.Flags().StringArrayVarP(&env, "env", "e", nil, "set an environment variable, K=V")
	return cmd
}

func (a *app) sshCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "ssh [<env>] [-- <command>…]",
		Short: "A shell, or a command, on the server",
		RunE: func(cmd *cobra.Command, args []string) error {
			pos, command := splitDash(cmd, args)
			if len(pos) > 1 {
				return errs.Usage("put the command after --: dockflow ssh [<env>] -- <command>")
			}
			a.quiet()
			ctx := cmd.Context()
			s, err := a.attach(ctx, envArg(pos))
			if err != nil {
				return err
			}
			defer s.Close()
			sess, err := s.ssh.NewSession()
			if err != nil {
				return errs.Connect("cannot open an SSH session").WithCause(err)
			}
			defer sess.Close()
			tty := isTerminal(a.stdin)
			if tty {
				w, h := terminalSize()
				if err := sess.RequestPty(os.Getenv("TERM"), int(h), int(w), ssh.TerminalModes{ssh.ECHO: 1}); err != nil {
					return errs.Connect("the server refuses a terminal").WithCause(err)
				}
			}
			stdin, _ := sess.StdinPipe()
			stdout, _ := sess.StdoutPipe()
			stderr, _ := sess.StderrPipe()
			if len(command) == 0 {
				err = sess.Shell()
			} else {
				err = sess.Start(strings.Join(command, " "))
			}
			if err != nil {
				return errs.Connect("cannot start the command on the server").WithCause(err)
			}
			_ = a.interact(ctx, interactive{stdin: stdin, stdout: stdout, stderr: stderr, tty: tty,
				resize: func(_ context.Context, w, h uint) error { return sess.WindowChange(int(h), int(w)) }})
			if err := sess.Wait(); err != nil {
				var exit *ssh.ExitError
				if errors.As(err, &exit) {
					return exitWith(exit.ExitStatus())
				}
				return errs.Connect("the SSH session ended").WithCause(err)
			}
			return nil
		},
	}
}

func (a *app) cpCmd() *cobra.Command {
	var pick bool
	cmd := &cobra.Command{
		Use:   "cp [<env>] <src> <dest>",
		Short: "Copy files between this machine and a container (service:/path), either way",
		Args:  cobra.RangeArgs(2, 3),
		RunE: func(cmd *cobra.Command, args []string) error {
			envName := ""
			if len(args) == 3 {
				envName, args = args[0], args[1:]
			}
			src, dest := args[0], args[1]
			srcSvc, srcPath, srcRemote := remotePath(src)
			destSvc, destPath, destRemote := remotePath(dest)
			if srcRemote == destRemote {
				return errs.Usage("one side must be a container path, service:/path, and the other a local path")
			}
			a.quiet()
			ctx := cmd.Context()
			s, err := a.attach(ctx, envName)
			if err != nil {
				return err
			}
			defer s.Close()
			if destRemote {
				c, err := a.serviceContainer(ctx, s, destSvc, pick)
				if err != nil {
					return err
				}
				dir, name := path.Split(destPath)
				if strings.HasSuffix(destPath, "/") {
					dir, name = destPath, filepath.Base(src)
				}
				pr, pw := io.Pipe()
				go func() { pw.CloseWithError(tarPath(pw, src, name)) }()
				return s.engine.CopyTo(ctx, c.ID, dir, pr)
			}
			c, err := a.serviceContainer(ctx, s, srcSvc, pick)
			if err != nil {
				return err
			}
			r, err := s.engine.CopyFrom(ctx, c.ID, srcPath)
			if err != nil {
				return err
			}
			defer r.Close()
			target := dest
			if st, err := os.Stat(dest); err == nil && st.IsDir() {
				target = filepath.Join(dest, path.Base(srcPath))
			}
			skipped, err := untarTo(r, target)
			for _, s := range skipped {
				a.emitter.Warn(events.Warning, "not copied: the symlink "+s+" points outside the destination",
					map[string]any{"code": "cp.symlink_outside", "detail": s})
			}
			return err
		},
	}
	cmd.Flags().BoolVar(&pick, "pick", false, "choose the container, when the service has several")
	return cmd
}

// remotePath splits service:/path; a local path has no colon before its first slash.
func remotePath(p string) (string, string, bool) {
	svc, rest, ok := strings.Cut(p, ":")
	if !ok || svc == "" || strings.ContainsAny(svc, `/\`) || !strings.HasPrefix(rest, "/") {
		return "", p, false
	}
	return svc, rest, true
}

// tarPath writes src (a file or a directory) to w, its top entry named name.
func tarPath(w io.Writer, src, name string) error {
	tw := tar.NewWriter(w)
	err := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		link := ""
		if info.Mode()&fs.ModeSymlink != 0 {
			if link, err = os.Readlink(p); err != nil {
				return err
			}
		}
		hdr, err := tar.FileInfoHeader(info, link)
		if err != nil {
			return err
		}
		hdr.Name = path.Join(name, filepath.ToSlash(rel))
		if rel == "." {
			hdr.Name = name
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			f, err := os.Open(p)
			if err != nil {
				return err
			}
			defer f.Close()
			_, err = io.Copy(tw, f)
			return err
		}
		return nil
	})
	if err != nil {
		return errs.Usage("cannot read %s: %v", src, err)
	}
	return tw.Close()
}

// untarTo extracts a tar, read from a container, whose top entry becomes target. Every write goes
// through an os.Root at the destination, so neither a path nor a symlink of the archive reaches
// outside it. A symlink whose target is absolute or leaves the destination is not created: its
// path is returned among the skipped. A file replaces a symlink in its place, never writes
// through it.
func untarTo(r io.Reader, target string) (skipped []string, err error) {
	tr := tar.NewReader(r)
	var root *os.Root
	defer func() {
		if root != nil {
			root.Close()
		}
	}()
	top, base := "", "."
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return skipped, nil
		}
		if err != nil {
			return skipped, errs.Internal("read the archive: %v", err)
		}
		name := path.Clean(hdr.Name)
		if top == "" {
			top = strings.SplitN(name, "/", 2)[0]
			// the destination directory is the root; a file or a link lands next to it, by name
			dir := target
			if hdr.Typeflag == tar.TypeDir {
				if err := os.MkdirAll(target, fs.FileMode(hdr.Mode).Perm()|0o700); err != nil {
					return skipped, err
				}
			} else {
				dir, base = filepath.Dir(target), filepath.Base(target)
			}
			if root, err = os.OpenRoot(dir); err != nil {
				return skipped, err
			}
		}
		var rel string
		switch {
		case name == top:
			rel = base
		case strings.HasPrefix(name, top+"/") && base == ".":
			rel = name[len(top)+1:]
		default:
			return skipped, errs.Internal("the archive holds a path outside its root: %s", hdr.Name)
		}
		if !filepath.IsLocal(filepath.FromSlash(rel)) {
			return skipped, errs.Internal("the archive holds a path outside its root: %s", hdr.Name)
		}
		dst := filepath.FromSlash(rel)
		switch hdr.Typeflag {
		case tar.TypeDir:
			if rel != "." {
				if err := root.MkdirAll(dst, fs.FileMode(hdr.Mode).Perm()|0o700); err != nil {
					return skipped, err
				}
			}
		case tar.TypeSymlink:
			if path.IsAbs(hdr.Linkname) || !filepath.IsLocal(filepath.FromSlash(path.Join(path.Dir(rel), hdr.Linkname))) {
				skipped = append(skipped, name+" -> "+hdr.Linkname)
				continue
			}
			_ = root.Remove(dst)
			if err := root.Symlink(hdr.Linkname, dst); err != nil {
				return skipped, err
			}
		case tar.TypeReg:
			if err := root.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
				return skipped, err
			}
			// a symlink of the archive in its place is replaced, not written through
			if st, err := root.Lstat(dst); err == nil && st.Mode()&fs.ModeSymlink != 0 {
				if err := root.Remove(dst); err != nil {
					return skipped, err
				}
			}
			f, err := root.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, fs.FileMode(hdr.Mode).Perm())
			if err != nil {
				return skipped, err
			}
			if _, err := io.Copy(f, tr); err != nil {
				f.Close()
				return skipped, err
			}
			f.Close()
		}
	}
}
