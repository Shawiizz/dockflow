package agent

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/shell"
)

const (
	// BackupsVolume holds the restic repository on the server, and BackupsCacheVolume restic's
	// cache.
	BackupsVolume      = "dockflow-backups"
	BackupsCacheVolume = "dockflow-backups-cache"
	// pruneEvery is how often a backup also reclaims the space of forgotten snapshots.
	pruneEvery = 24 * time.Hour
	// resticNoRepository is restic's exit code for a repository that does not exist.
	resticNoRepository = 10
)

// repo is a restic repository, opened for one run.
type repo struct {
	image  string
	key    string // names the files of this repository in the state directory
	mounts []domain.Mount
	close  func()
}

// openRepo prepares restic's environment: the repository, its password and the storage's
// credentials, in a file of the secrets' tmpfs that the restic containers read (ADR-0012),
// never in their configuration.
// Without create, a repository whose password Dockflow did not generate yet has no snapshot:
// openRepo returns nil.
func (r *runner) openRepo(ctx context.Context, create bool) (*repo, error) {
	b := r.req.Backup
	if b == nil {
		b = &BackupRequest{}
	}
	image, err := r.Engine.ResolveImage(ctx, DefaultResticImage, "missing", nil)
	if err != nil {
		return nil, err
	}
	rp := &repo{image: image, key: "local"}
	env := map[string]string{"RESTIC_CACHE_DIR": "/cache"}
	if b.Repository == "" {
		env["RESTIC_REPOSITORY"] = "/repo"
		rp.mounts = append(rp.mounts, domain.Mount{Type: "volume", Source: BackupsVolume, Target: "/repo"})
	} else {
		sum := sha256.Sum256([]byte(b.Repository))
		rp.key = hex.EncodeToString(sum[:])[:16]
		env["RESTIC_REPOSITORY"] = b.Repository
	}
	for k, v := range b.Env {
		env[k] = v
	}
	password := b.Password
	if password == "" {
		if password, err = r.repoPassword(rp.key, create); err != nil || password == "" {
			return nil, err
		}
	}
	r.ev.Masker().Add(password)
	env["RESTIC_PASSWORD"] = password

	dir := filepath.Join(filepath.Dir(domain.SecretsRoot), "backup-"+r.req.Run)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, errs.Internal("create %s: %v", dir, err)
	}
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var sb strings.Builder
	for _, k := range keys {
		fmt.Fprintf(&sb, "export %s=%s\n", k, shell.Quote(env[k]))
	}
	if err := os.WriteFile(filepath.Join(dir, "env"), []byte(sb.String()), 0o600); err != nil {
		os.RemoveAll(dir)
		return nil, errs.Internal("write restic's environment: %v", err)
	}
	rp.mounts = append(rp.mounts,
		domain.Mount{Type: "bind", Source: dir, Target: "/run/backup", ReadOnly: true},
		domain.Mount{Type: "volume", Source: BackupsCacheVolume, Target: "/cache"})
	rp.close = func() { os.RemoveAll(dir) }
	return rp, nil
}

// repoPassword reads the password Dockflow generated for a repository, or generates it with
// create.
func (r *runner) repoPassword(key string, create bool) (string, error) {
	path := filepath.Join(r.Store.Root(), "backups", key+".password")
	if b, err := os.ReadFile(path); err == nil {
		return strings.TrimSpace(string(b)), nil
	}
	if !create {
		return "", nil
	}
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", errs.Internal("generate the repository's password: %v", err)
	}
	pw := base64.RawURLEncoding.EncodeToString(buf)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", errs.Internal("create %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(pw+"\n"), 0o600); err != nil {
		return "", errs.Internal("store the repository's password: %v", err)
	}
	r.warn("backup.password_generated", "the backups' password was generated and stored in "+path+
		", readable by root: keep a copy elsewhere, the backups cannot be read without it")
	return pw, nil
}

// resticRun is one restic command's outcome.
type resticRun struct {
	stdout, stderr []byte
	code           int
}

// restic runs restic with args in a one-off container. extra are mounts of data to back up or
// restore; stdin, when set, writes the container's standard input.
func (r *runner) restic(ctx context.Context, rp *repo, args []string, extra []domain.Mount, stdin func(io.Writer) error) (*resticRun, error) {
	return r.resticPipe(ctx, rp, args, extra, stdin, nil)
}

// resticPipe is restic; with stdout, restic's standard output streams there instead of being
// kept.
func (r *runner) resticPipe(ctx context.Context, rp *repo, args []string, extra []domain.Mount, stdin func(io.Writer) error, stdout io.Writer) (*resticRun, error) {
	spec := domain.ContainerSpec{
		Image:      rp.image,
		Entrypoint: []string{"sh", "-c", `. /run/backup/env && exec restic "$@"`, "restic"},
		Command:    args,
		Mounts:     append(append([]domain.Mount{}, rp.mounts...), extra...),
		Restart:    "no",
		StdinOpen:  stdin != nil,
		StdinOnce:  stdin != nil,
	}
	labels := map[string]string{
		domain.LabelKind: domain.KindHelper, domain.LabelSchema: "1", domain.LabelManagedBy: "true", domain.LabelOneOff: "True",
	}
	if r.stack != "" {
		labels[domain.LabelProject] = r.stack
	}
	suffix := make([]byte, 4)
	_, _ = rand.Read(suffix)
	id, err := r.Engine.Create(ctx, "dockflow-restic-"+r.req.Run+"-"+hex.EncodeToString(suffix), spec, labels)
	if err != nil {
		return nil, err
	}
	defer func() { _ = r.Engine.Remove(context.WithoutCancel(ctx), id) }()
	att, err := r.Engine.Attach(ctx, id, false)
	if err != nil {
		return nil, err
	}
	defer att.Close()
	if err := r.Engine.Start(ctx, id); err != nil {
		return nil, err
	}
	var out, errOut bytes.Buffer
	var w io.Writer = &out
	if stdout != nil {
		// a reader that stops early must not leave restic blocked on its output
		w = &tolerant{w: stdout}
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); _, _ = io.Copy(w, att.Stdout) }()
	go func() { defer wg.Done(); _, _ = io.Copy(&errOut, att.Stderr) }()
	var inErr error
	if stdin != nil {
		inErr = stdin(att.Stdin)
	}
	_ = att.Stdin.Close()
	wg.Wait()
	code, err := r.Engine.Wait(context.WithoutCancel(ctx), id)
	if err != nil {
		return nil, err
	}
	res := &resticRun{stdout: out.Bytes(), stderr: errOut.Bytes(), code: code}
	if inErr != nil {
		return res, inErr
	}
	if ctx.Err() != nil {
		return res, interrupted()
	}
	return res, nil
}

// tolerant writes to w until it fails, then discards: the error is kept.
type tolerant struct {
	w   io.Writer
	err error
}

func (t *tolerant) Write(p []byte) (int, error) {
	if t.err == nil {
		_, t.err = t.w.Write(p)
	}
	return len(p), nil
}

// lastLines are the end of a command's error output, for a message.
func lastLines(b []byte, n int) string {
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " / ")
}

// ensureRepo creates the repository when it does not exist yet.
func (r *runner) ensureRepo(ctx context.Context, rp *repo) error {
	// init first: it creates a missing bucket, where reading the repository's config would
	// retry for minutes before giving up
	res, err := r.restic(ctx, rp, []string{"init"}, nil, nil)
	if err != nil {
		return err
	}
	switch {
	case res.code == 0:
		r.ev.Info(events.Log, "backup repository created", map[string]any{"line": "restic init"})
		return nil
	case strings.Contains(string(res.stderr), "config file already exists"):
		return nil
	}
	return errs.Newf("backup.repository", errs.ExitBackup, "cannot open the backup repository: %s", lastLines(res.stderr, 3)).
		WithHint("check backups.repository, its credentials in backups.env, and the password")
}

// backupTags select this environment's snapshots, and a service's when service is set.
func (r *runner) backupTags(service string) string {
	return r.backupTagsOf(r.req.Env, service)
}

// backupTagsOf select an environment's snapshots, and a service's when service is set.
func (r *runner) backupTagsOf(env, service string) string {
	tags := []string{"app=" + r.req.App, "env=" + env}
	if service != "" {
		tags = append(tags, "service="+service)
	}
	return strings.Join(tags, ",")
}

// BackupResult is one service's backup.
type BackupResult struct {
	Service    string `json:"service"`
	Snapshot   string `json:"snapshot"`
	BytesAdded int64  `json:"bytes_added"`
	DurationMS int64  `json:"duration_ms"`
}

// backupRun backs up the services of the current release that declare a backup (ADR-0015).
func (r *runner) backupRun(ctx context.Context) events.RunFinishedData {
	if r.req.Backup != nil && r.req.Backup.Server {
		return r.backupServer(ctx)
	}
	l, err := r.lock(ctx)
	if err != nil {
		return failed(err)
	}
	defer r.unlock(l)
	rel, err := r.currentRelease()
	if err != nil {
		return failed(err)
	}
	svcs, err := r.backedUp(rel)
	if err != nil {
		return failed(err)
	}
	if len(svcs) == 0 {
		// a scheduled backup of an app with no stateful service yet is not a failure
		r.warn("backup.none", fmt.Sprintf("no service of release %d of %s declares a backup: nothing to back up", rel.Seq, r.stack))
		r.result(map[string]any{"backups": []BackupResult{}})
		return events.RunFinishedData{Outcome: events.OutcomeSuccess}
	}
	rp, err := r.openRepo(ctx, true)
	if err != nil {
		return failed(err)
	}
	defer rp.close()
	if err := r.ensureRepo(ctx, rp); err != nil {
		return failed(err)
	}
	results := []BackupResult{}
	var failures []string
	for _, svc := range svcs {
		res, err := r.backupService(ctx, rp, rel, svc)
		if err != nil {
			if ctx.Err() != nil {
				return failed(interrupted())
			}
			failures = append(failures, svc.Name)
			r.ev.Emit(events.Error, events.Warning, fmt.Sprintf("backup of %s failed: %v", svc.Name, err), map[string]any{"code": "backup.failed", "service": svc.Name})
			continue
		}
		results = append(results, *res)
		if err := r.forget(ctx, rp, svc); err != nil {
			failures = append(failures, svc.Name)
			r.ev.Emit(events.Error, events.Warning, fmt.Sprintf("retention of %s failed: %v", svc.Name, err), map[string]any{"code": "backup.retention", "service": svc.Name})
		}
	}
	if len(results) > 0 {
		if err := r.checkRepo(ctx, rp); err != nil {
			r.result(map[string]any{"backups": results})
			return failed(err)
		}
	}
	r.result(map[string]any{"backups": results})
	if len(failures) > 0 {
		return failed(errs.Newf("backup.failed", errs.ExitBackup, "the backup of %s failed", strings.Join(failures, ", ")).
			WithHint("the reason of each is above"))
	}
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}

// serverName names this server in the snapshots.
func (r *runner) serverName() string {
	if r.req.Server == "" {
		return "main"
	}
	return r.req.Server
}

// serverTags select the snapshots of this server's state.
func (r *runner) serverTags() string {
	return "server=" + r.serverName()
}

// backupServer backs up the server's state, so that a lost server can be rebuilt with its
// releases' history (ADR-0015). The passwords of the backups stay out: a snapshot that holds
// its own repository's password protects nothing.
func (r *runner) backupServer(ctx context.Context) events.RunFinishedData {
	rp, err := r.openRepo(ctx, true)
	if err != nil {
		return failed(err)
	}
	defer rp.close()
	if err := r.ensureRepo(ctx, rp); err != nil {
		return failed(err)
	}
	root := r.Store.Root()
	r.ev.Info(events.Log, "backing up "+root, map[string]any{"line": "backup " + root})
	args := []string{"backup", "--json", "--host", r.serverName(), "--tag", r.serverTags(),
		"--exclude", filepath.Join(root, "backups"), "--exclude", "*.tmp-*", root}
	res, err := r.restic(ctx, rp, args, []domain.Mount{{Type: "bind", Source: root, Target: root, ReadOnly: true}}, nil)
	if err != nil {
		return failed(err)
	}
	out, err := backupSummary(res)
	if err != nil {
		return failed(errs.Newf("backup.failed", errs.ExitBackup, "the backup of %s failed: %v", root, err))
	}
	r.ev.Info(events.BackupFinished, fmt.Sprintf("%s backed up: snapshot %s, %s added", root, out.Snapshot, humanSize(uint64(out.BytesAdded))), map[string]any{
		"server": r.serverName(), "snapshot": out.Snapshot, "bytes_added": out.BytesAdded, "duration_ms": out.DurationMS,
	})
	r.result(map[string]any{"backups": []BackupResult{*out}})
	if _, err := r.forgetKeep(ctx, rp, r.serverTags(), nil, false); err != nil {
		return failed(errs.Newf("backup.retention", errs.ExitBackup, "the retention of the server's backups failed: %v", err))
	}
	if err := r.checkRepo(ctx, rp); err != nil {
		return failed(err)
	}
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}

// backedUp are the services of rel to back up: those with a backup, maybe none, or the
// requested one.
func (r *runner) backedUp(rel *domain.Release) ([]*domain.Service, error) {
	only := ""
	if r.req.Backup != nil {
		only = r.req.Backup.Service
	}
	var out []*domain.Service
	for i := range rel.Desired.Services {
		s := &rel.Desired.Services[i]
		if only != "" && s.Name != only {
			continue
		}
		if s.Backup == nil {
			if only != "" {
				return nil, errs.Newf("backup.none", errs.ExitUsage, "service %s of release %d declares no backup", only, rel.Seq).
					WithHint("set x-dockflow.backup on it, and deploy")
			}
			continue
		}
		out = append(out, s)
	}
	if only != "" && len(out) == 0 {
		return nil, errs.Newf("backup.none", errs.ExitUsage, "release %d of %s has no service %s", rel.Seq, r.stack, only)
	}
	return out, nil
}

// runningContainer is the newest running container of a service of the current release.
func (r *runner) runningContainer(ctx context.Context, svc *domain.Service) (engine.Container, error) {
	cs, err := r.Engine.Containers(ctx, engine.Filter{Labels: map[string]string{
		domain.LabelProject: r.stack, domain.LabelService: svc.Name, domain.LabelKind: domain.KindService,
	}})
	if err != nil {
		return engine.Container{}, err
	}
	cs = newest(cs)
	if len(cs) == 0 {
		return engine.Container{}, errs.Newf("backup.not_running", errs.ExitBackup, "%s has no running container", svc.Name).
			WithHint("start it with `dockflow restart`")
	}
	return cs[0], nil
}

// envValue is the value of key in a container's environment.
func envValue(env []string, key, def string) string {
	for _, kv := range env {
		if k, v, ok := strings.Cut(kv, "="); ok && k == key && v != "" {
			return v
		}
	}
	return def
}

// dumpCommand is the command a dump type runs in the service's container, and the name of
// its output in the snapshot.
func dumpCommand(svc *domain.Service) ([]string, string) {
	b := svc.Backup
	switch b.Type {
	case domain.BackupPostgres:
		user := envValue(svc.Spec.Env, "POSTGRES_USER", "postgres")
		db := b.Database
		if db == "" {
			db = envValue(svc.Spec.Env, "POSTGRES_DB", user)
		}
		cmd := append([]string{"pg_dump", "--username", user, "--format=custom"}, b.DumpOptions...)
		return append(cmd, db), svc.Name + ".pgdump"
	case domain.BackupMySQL:
		return append([]string{"sh", "-c", mysqlCredentials + mysqlDump, "sh", b.Database}, b.DumpOptions...), svc.Name + ".sql"
	case domain.BackupMongo:
		return append([]string{"sh", "-c", mongoCredentials + `if [ -n "$db" ]; then set -- --db="$db" "$@"; fi
mongodump --archive "$@"
`, "sh", b.Database}, b.DumpOptions...), svc.Name + ".archive"
	case domain.BackupRedis:
		return append([]string{"sh", "-c", redisDump, "sh"}, b.DumpOptions...), svc.Name + ".rdb"
	case domain.BackupCommand:
		return b.Dump, svc.Name + ".dump"
	}
	return nil, ""
}

// The dump and restore scripts of the mysql, mongo and redis types run in the service's
// container, with its own environment: the credentials never leave it, and never reach a
// command line ($1 is the database, the options follow).
const (
	// mysqlCredentials writes the client's credentials, from the image's variables, to a file
	// only this command reads.
	mysqlCredentials = `set -e
db="$1"; shift
[ -n "$db" ] || db="${MYSQL_DATABASE:-${MARIADB_DATABASE:-}}"
user=root; pass="${MYSQL_ROOT_PASSWORD:-${MARIADB_ROOT_PASSWORD:-}}"
if [ -z "$pass" ]; then user="${MYSQL_USER:-${MARIADB_USER:-root}}"; pass="${MYSQL_PASSWORD:-${MARIADB_PASSWORD:-}}"; fi
cnf=$(mktemp); trap 'rm -f "$cnf"' EXIT
printf '[client]\nuser=%s\npassword="%s"\n' "$user" "$pass" > "$cnf"
`
	mysqlDump = `dump=$(command -v mariadb-dump || command -v mysqldump)
if [ -n "$db" ]; then set -- "$@" --databases "$db"; else set -- "$@" --all-databases; fi
"$dump" --defaults-extra-file="$cnf" --single-transaction --routines --events "$@"
`
	mysqlRestore = `client=$(command -v mariadb || command -v mysql)
"$client" --defaults-extra-file="$cnf" "$@"
`
	// mongoCredentials adds the root user of the image's variables, its password in a file.
	mongoCredentials = `set -e
db="$1"; shift
if [ -n "${MONGO_INITDB_ROOT_USERNAME:-}" ]; then
	cnf=$(mktemp); trap 'rm -f "$cnf"' EXIT
	printf 'password: "%s"\n' "$MONGO_INITDB_ROOT_PASSWORD" > "$cnf"
	set -- --config="$cnf" --username="$MONGO_INITDB_ROOT_USERNAME" --authenticationDatabase=admin "$@"
fi
`
	redisDump = `set -e
[ -z "${REDIS_PASSWORD:-}" ] || export REDISCLI_AUTH="$REDIS_PASSWORD"
rdb=$(mktemp); trap 'rm -f "$rdb"' EXIT
redis-cli "$@" --rdb "$rdb" >/dev/null
cat "$rdb"
`
)

// backupService backs up one service and returns its snapshot.
func (r *runner) backupService(ctx context.Context, rp *repo, rel *domain.Release, svc *domain.Service) (*BackupResult, error) {
	b := svc.Backup
	args := []string{"backup", "--json", "--host", r.serverName(),
		"--tag", r.backupTags(svc.Name) + ",release=" + strconv.Itoa(rel.Seq)}
	r.ev.Info(events.Log, "backing up "+svc.Name+" ("+b.Type+")", map[string]any{"line": "backup " + svc.Name})
	var res *resticRun
	var err error
	switch b.Type {
	case domain.BackupVolume:
		res, err = r.backupVolumes(ctx, rp, svc, args)
	default:
		res, err = r.backupDump(ctx, rp, svc, args)
	}
	if err != nil {
		return nil, err
	}
	out, err := backupSummary(res)
	if err != nil {
		return nil, err
	}
	out.Service = svc.Name
	r.ev.Info(events.BackupFinished, fmt.Sprintf("%s backed up: snapshot %s, %s added", svc.Name, out.Snapshot, humanSize(uint64(out.BytesAdded))), map[string]any{
		"service": svc.Name, "snapshot": out.Snapshot, "bytes_added": out.BytesAdded, "duration_ms": out.DurationMS,
	})
	return out, nil
}

// backupDump streams a dump command's output from the service's container into restic.
func (r *runner) backupDump(ctx context.Context, rp *repo, svc *domain.Service, args []string) (*resticRun, error) {
	c, err := r.runningContainer(ctx, svc)
	if err != nil {
		return nil, err
	}
	cmd, name := dumpCommand(svc)
	args = append(args, "--stdin", "--stdin-filename", name)
	var dumpErr error
	res, err := r.restic(ctx, rp, args, nil, func(w io.Writer) error {
		ex, err := r.Engine.Exec(ctx, c.ID, engine.ExecOptions{Cmd: cmd})
		if err != nil {
			return err
		}
		defer ex.Close()
		_ = ex.Stdin.Close()
		var stderr bytes.Buffer
		done := make(chan struct{})
		go func() { _, _ = io.Copy(&stderr, ex.Stderr); close(done) }()
		_, copyErr := io.Copy(w, ex.Stdout)
		<-done
		code, err := ex.Wait(context.WithoutCancel(ctx))
		switch {
		case err != nil:
			dumpErr = err
		case code != 0:
			dumpErr = fmt.Errorf("%s exited with code %d: %s", cmd[0], code, lastLines(stderr.Bytes(), 3))
		case copyErr != nil:
			dumpErr = copyErr
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if dumpErr != nil {
		// restic kept what it read: that snapshot holds a partial dump
		if s, err := backupSummary(res); err == nil {
			_, _ = r.restic(context.WithoutCancel(ctx), rp, []string{"forget", s.Snapshot}, nil, nil)
		}
		return nil, dumpErr
	}
	return res, nil
}

// backupVolumes copies the service's volumes, read-only, with its writes stopped as quiesce
// says.
func (r *runner) backupVolumes(ctx context.Context, rp *repo, svc *domain.Service, args []string) (*resticRun, error) {
	b := svc.Backup
	var mounts []domain.Mount
	for _, target := range b.Volumes {
		found := false
		for _, m := range svc.Spec.Mounts {
			if m.Target == target && (m.Type == "volume" || m.Type == "bind") {
				mounts = append(mounts, domain.Mount{Type: m.Type, Source: m.Source, Target: "/data" + target, ReadOnly: true})
				args = append(args, "/data"+target)
				found = true
			}
		}
		if !found {
			return nil, fmt.Errorf("%s mounts nothing at %s", svc.Name, target)
		}
	}
	resume, err := r.quiesce(ctx, svc)
	if err != nil {
		return nil, err
	}
	res, err := r.restic(ctx, rp, args, mounts, nil)
	if rerr := resume(); rerr != nil {
		r.ev.Emit(events.Error, events.Warning, fmt.Sprintf("%s: writes could not be resumed: %v", svc.Name, rerr), map[string]any{"code": "backup.resume", "service": svc.Name})
	}
	return res, err
}

// quiesce stops a service's writes for a volume backup, and returns how to resume them.
func (r *runner) quiesce(ctx context.Context, svc *domain.Service) (func() error, error) {
	q := svc.Backup.Quiesce
	switch q.Mode {
	case domain.QuiesceNone:
		return func() error { return nil }, nil
	case domain.QuiesceExec:
		c, err := r.runningContainer(ctx, svc)
		if err != nil {
			return nil, err
		}
		if err := r.backupExec(ctx, svc, c, q.Pre); err != nil {
			_ = r.backupExec(context.WithoutCancel(ctx), svc, c, q.Post)
			return nil, fmt.Errorf("quiesce pre: %w", err)
		}
		return func() error { return r.backupExec(context.WithoutCancel(ctx), svc, c, q.Post) }, nil
	default:
		return r.stopService(ctx, svc, "its backup")
	}
}

// stopService stops a service's running containers, and returns how to start them again.
func (r *runner) stopService(ctx context.Context, svc *domain.Service, why string) (func() error, error) {
	cs, err := r.Engine.Containers(ctx, engine.Filter{Labels: map[string]string{
		domain.LabelProject: r.stack, domain.LabelService: svc.Name, domain.LabelKind: domain.KindService,
	}})
	if err != nil {
		return nil, err
	}
	var grace *time.Duration
	if svc.Spec.StopGrace != nil {
		d := svc.Spec.StopGrace.D()
		grace = &d
	}
	var stopped []engine.Container
	resume := func() error {
		var errAll error
		for _, c := range stopped {
			errAll = errors.Join(errAll, r.Engine.Start(context.WithoutCancel(ctx), c.ID))
		}
		return errAll
	}
	for _, c := range cs {
		r.ev.Info(events.Log, "stopping "+c.Name+" for "+why, map[string]any{"line": "stop " + c.Name})
		if err := r.Engine.Stop(ctx, c.ID, grace); err != nil {
			_ = resume()
			return nil, err
		}
		stopped = append(stopped, c)
	}
	return resume, nil
}

// backupExec runs a quiesce command in the service's container, its output as log events.
func (r *runner) backupExec(ctx context.Context, svc *domain.Service, c engine.Container, cmd []string) error {
	if len(cmd) == 0 {
		return nil
	}
	ex, err := r.Engine.Exec(ctx, c.ID, engine.ExecOptions{Cmd: cmd})
	if err != nil {
		return err
	}
	defer ex.Close()
	_ = ex.Stdin.Close()
	var wg sync.WaitGroup
	for _, stream := range []io.Reader{ex.Stdout, ex.Stderr} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sc := bufio.NewScanner(stream)
			for sc.Scan() {
				r.ev.Info(events.Log, svc.Name+" │ "+sc.Text(), map[string]any{"service": svc.Name, "line": sc.Text()})
			}
		}()
	}
	wg.Wait()
	code, err := ex.Wait(ctx)
	if err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("%s exited with code %d", strings.Join(cmd, " "), code)
	}
	return nil
}

// backupSummary reads the summary restic --json prints at the end of a backup.
func backupSummary(res *resticRun) (*BackupResult, error) {
	for _, line := range strings.Split(string(res.stdout), "\n") {
		var m struct {
			Type      string  `json:"message_type"`
			Snapshot  string  `json:"snapshot_id"`
			DataAdded int64   `json:"data_added"`
			Duration  float64 `json:"total_duration"`
		}
		if json.Unmarshal([]byte(line), &m) == nil && m.Type == "summary" && m.Snapshot != "" {
			return &BackupResult{Snapshot: m.Snapshot[:8], BytesAdded: m.DataAdded, DurationMS: int64(m.Duration * 1000)}, nil
		}
	}
	if res.code == 0 {
		return nil, fmt.Errorf("restic printed no summary")
	}
	return nil, fmt.Errorf("restic exited with code %d: %s", res.code, lastLines(res.stderr, 3))
}

// forget applies the service's retention, and reclaims space once a day.
func (r *runner) forget(ctx context.Context, rp *repo, svc *domain.Service) error {
	_, err := r.forgetKeep(ctx, rp, r.backupTags(svc.Name), svc.Backup.Keep, false)
	return err
}

// forgetKeep applies keep, or the default retention, to the snapshots with tags, and returns
// how many it forgot. It reclaims space with prune, or once a day.
func (r *runner) forgetKeep(ctx context.Context, rp *repo, tags string, keep *domain.Keep, prune bool) (int, error) {
	if keep.Empty() {
		keep = &domain.DefaultKeep
	}
	args := []string{"forget", "--json", "--tag", tags}
	for _, k := range []struct {
		flag string
		n    int
	}{{"--keep-last", keep.Last}, {"--keep-hourly", keep.Hourly}, {"--keep-daily", keep.Daily}, {"--keep-weekly", keep.Weekly}, {"--keep-monthly", keep.Monthly}} {
		if k.n > 0 {
			args = append(args, k.flag, strconv.Itoa(k.n))
		}
	}
	stamp := filepath.Join(r.Store.Root(), "backups", rp.key+".pruned")
	if !prune {
		prune = true
		if b, err := os.ReadFile(stamp); err == nil {
			if t, err := time.Parse(time.RFC3339, strings.TrimSpace(string(b))); err == nil && r.Now().Sub(t) < pruneEvery {
				prune = false
			}
		}
	}
	if prune {
		args = append(args, "--prune")
	}
	res, err := r.restic(ctx, rp, args, nil, nil)
	if err != nil {
		return 0, err
	}
	if res.code != 0 {
		return 0, fmt.Errorf("restic forget exited with code %d: %s", res.code, lastLines(res.stderr, 3))
	}
	if prune {
		_ = os.MkdirAll(filepath.Dir(stamp), 0o700)
		_ = os.WriteFile(stamp, []byte(r.Now().UTC().Format(time.RFC3339)+"\n"), 0o600)
	}
	// the first line is the JSON of the groups; --prune's report follows
	removed := 0
	line, _, _ := strings.Cut(string(res.stdout), "\n")
	var groups []struct {
		Remove []json.RawMessage `json:"remove"`
	}
	if json.Unmarshal([]byte(line), &groups) == nil {
		for _, g := range groups {
			removed += len(g.Remove)
		}
	}
	return removed, nil
}

// checkRepo checks the repository's structure and a sample of its data.
func (r *runner) checkRepo(ctx context.Context, rp *repo) error {
	res, err := r.restic(ctx, rp, []string{"check", "--read-data-subset=1%"}, nil, nil)
	if err != nil {
		return err
	}
	if res.code != 0 {
		return errs.Newf("backup.check", errs.ExitBackup, "the backup repository failed its check: %s", lastLines(res.stderr, 3)).
			WithHint("run restic check on the repository to see its errors")
	}
	r.ev.Info(events.Log, "backup repository checked", map[string]any{"line": "restic check"})
	return nil
}

// Snapshot is a backup of a service, or of a server's state, as backup list shows it.
type Snapshot struct {
	ID      string    `json:"id"`
	Time    time.Time `json:"time"`
	Service string    `json:"service,omitempty"`
	Server  string    `json:"server,omitempty"`
	Release int       `json:"release,omitempty"`
	Size    int64     `json:"size,omitempty"`
}

// snapshots lists the snapshots with tags, oldest first.
func (r *runner) snapshots(ctx context.Context, rp *repo, tags string) ([]Snapshot, error) {
	res, err := r.restic(ctx, rp, []string{"snapshots", "--json", "--no-lock", "--tag", tags}, nil, nil)
	if err != nil {
		return nil, err
	}
	if res.code == resticNoRepository {
		return []Snapshot{}, nil
	}
	if res.code != 0 {
		return nil, errs.Newf("backup.repository", errs.ExitBackup, "cannot list the snapshots: %s", lastLines(res.stderr, 3))
	}
	var raw []struct {
		ID      string    `json:"short_id"`
		Time    time.Time `json:"time"`
		Tags    []string  `json:"tags"`
		Summary *struct {
			Total int64 `json:"total_bytes_processed"`
		} `json:"summary"`
	}
	if err := json.Unmarshal(res.stdout, &raw); err != nil {
		return nil, errs.Internal("read restic's snapshots: %v", err)
	}
	out := []Snapshot{}
	for _, s := range raw {
		snap := Snapshot{ID: s.ID, Time: s.Time}
		for _, t := range s.Tags {
			switch k, v, _ := strings.Cut(t, "="); k {
			case "service":
				snap.Service = v
			case "server":
				snap.Server = v
			case "release":
				snap.Release, _ = strconv.Atoi(v)
			}
		}
		if s.Summary != nil {
			snap.Size = s.Summary.Total
		}
		out = append(out, snap)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Time.Before(out[j].Time) })
	return out, nil
}

// backupList lists the environment's snapshots.
func (r *runner) backupList(ctx context.Context) events.RunFinishedData {
	rp, err := r.openRepo(ctx, false)
	if err != nil {
		return failed(err)
	}
	if rp == nil {
		r.result(map[string]any{"snapshots": []Snapshot{}})
		return events.RunFinishedData{Outcome: events.OutcomeSuccess}
	}
	defer rp.close()
	tags := r.backupTags("")
	switch b := r.req.Backup; {
	case b != nil && b.Server:
		tags = r.serverTags()
	case b != nil:
		tags = r.backupTags(b.Service)
	}
	snaps, err := r.snapshots(ctx, rp, tags)
	if err != nil {
		return failed(err)
	}
	r.result(map[string]any{"snapshots": snaps})
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}
