package agent

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/state"
)

// pickSnapshot is the snapshot sel names among snaps, oldest first: latest (or nothing), an id
// or its prefix, or a date or time, for the newest snapshot taken by then.
func pickSnapshot(snaps []Snapshot, sel string) (Snapshot, error) {
	if len(snaps) == 0 {
		return Snapshot{}, errs.Newf("backup.snapshot", errs.ExitBackup, "no snapshot to restore").
			WithHint("dockflow backup list shows the snapshots; dockflow backup run makes one")
	}
	if sel == "" || sel == "latest" {
		return snaps[len(snaps)-1], nil
	}
	var by time.Time
	if t, err := time.Parse(time.RFC3339, sel); err == nil {
		by = t
	} else if d, err := time.Parse("2006-01-02", sel); err == nil {
		by = d.Add(24*time.Hour - time.Nanosecond)
	}
	if !by.IsZero() {
		for i := len(snaps) - 1; i >= 0; i-- {
			if !snaps[i].Time.After(by) {
				return snaps[i], nil
			}
		}
		return Snapshot{}, errs.Newf("backup.snapshot", errs.ExitUsage, "no snapshot was taken by %s: the oldest is from %s", sel, snaps[0].Time.UTC().Format(time.RFC3339))
	}
	var found []Snapshot
	for _, s := range snaps {
		if strings.HasPrefix(s.ID, sel) {
			found = append(found, s)
		}
	}
	switch len(found) {
	case 0:
		return Snapshot{}, errs.Newf("backup.snapshot", errs.ExitUsage, "no snapshot %s", sel).
			WithHint("give an id that dockflow backup list shows, latest, or a date like 2026-10-27")
	case 1:
		return found[0], nil
	}
	return Snapshot{}, errs.Newf("backup.snapshot", errs.ExitUsage, "%s names %d snapshots: give more of its id", sel, len(found))
}

// restoredService is the service of the current release a restore names.
func (r *runner) restoredService(rel *domain.Release) (*domain.Service, error) {
	name := ""
	if r.req.Backup != nil {
		name = r.req.Backup.Service
	}
	if name == "" {
		return nil, errs.Usage("name the service to restore")
	}
	svc, ok := rel.Desired.Service(name)
	if !ok {
		return nil, errs.Newf("backup.none", errs.ExitUsage, "release %d of %s has no service %s", rel.Seq, r.stack, name)
	}
	if svc.Backup == nil {
		return nil, errs.Newf("backup.none", errs.ExitUsage, "service %s of release %d declares no backup", name, rel.Seq)
	}
	return svc, nil
}

// backupRestore restores a snapshot of a service, of this environment or of From, into what
// runs now (ADR-0015).
func (r *runner) backupRestore(ctx context.Context) events.RunFinishedData {
	l, err := r.lock(ctx)
	if err != nil {
		return failed(err)
	}
	defer r.unlock(l)
	if err := r.finishLeft(ctx); err != nil {
		return failed(err)
	}
	rel, err := r.currentRelease()
	if err != nil {
		return failed(err)
	}
	svc, err := r.restoredService(rel)
	if err != nil {
		return failed(err)
	}
	from := r.req.Backup.From
	if from == "" {
		from = r.req.Env
	}
	rp, err := r.openRepo(ctx, false)
	if err != nil {
		return failed(err)
	}
	if rp == nil {
		return failed(errs.Newf("backup.snapshot", errs.ExitBackup, "%s has no backup on this server", from).
			WithHint("backups of another server are restored from an off-site repository: backups.repository"))
	}
	defer rp.close()
	snaps, err := r.snapshots(ctx, rp, r.backupTagsOf(from, svc.Name))
	if err != nil {
		return failed(err)
	}
	snap, err := pickSnapshot(snaps, r.req.Backup.Snapshot)
	if err != nil {
		return failed(err)
	}
	ctx = context.WithoutCancel(ctx)
	r.ev.Info(events.Log, fmt.Sprintf("restoring %s from snapshot %s of %s (%s, release %d)", svc.Name, snap.ID, from, snap.Time.UTC().Format(time.RFC3339), snap.Release),
		map[string]any{"line": "restore " + svc.Name + " " + snap.ID})
	switch svc.Backup.Type {
	case domain.BackupVolume:
		err = r.restoreVolumes(ctx, rp, svc, snap)
	case domain.BackupRedis:
		err = r.restoreRedis(ctx, rp, svc, snap)
	default:
		err = r.restoreDump(ctx, rp, svc, snap)
	}
	if err != nil {
		return failed(errs.Newf("backup.restore_failed", errs.ExitBackup, "the restore of %s failed: %v", svc.Name, err))
	}
	r.ev.Info(events.Log, svc.Name+" restored from snapshot "+snap.ID, map[string]any{"line": "restored " + svc.Name})
	r.result(map[string]any{"service": svc.Name, "snapshot": snap.ID, "from": from, "time": snap.Time})
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}

// restoreCommand is the command a dump type is restored with, in the service's container, the
// dump on its stdin: with the strictest options, so that the first error stops it. size is the
// dump's size: mysql and mongo, which change the data as they read, read nothing until the whole
// dump has arrived, and a dump cut short changes nothing; pg_restore rolls back on its own.
func restoreCommand(svc *domain.Service, size int64) []string {
	b := svc.Backup
	n := strconv.FormatInt(size, 10)
	switch b.Type {
	case domain.BackupPostgres:
		user := envValue(svc.Spec.Env, "POSTGRES_USER", "postgres")
		db := b.Database
		if db == "" {
			db = envValue(svc.Spec.Env, "POSTGRES_DB", user)
		}
		cmd := []string{"pg_restore", "--username", user, "--dbname", db, "--clean", "--if-exists", "--single-transaction", "--exit-on-error"}
		return append(cmd, b.RestoreOptions...)
	case domain.BackupMySQL:
		return append([]string{"sh", "-c", stageSize + mysqlCredentials + stageDump + mysqlRestore, "sh", n, b.Database}, b.RestoreOptions...)
	case domain.BackupMongo:
		return append([]string{"sh", "-c", stageSize + mongoCredentials + stageDump + `if [ -n "$db" ]; then set -- --nsInclude="$db.*" "$@"; fi
mongorestore --archive --drop --stopOnError "$@" < "$dump"
`, "sh", n, b.Database}, b.RestoreOptions...)
	case domain.BackupCommand:
		return b.Restore
	}
	return nil
}

// stageSize and stageDump keep the dump in a temporary file of the container, and check that all
// of it arrived ($1 is its size), before the restore reads it from "$dump".
const (
	stageSize = `size="$1"; shift
`
	stageDump = `dump=$(mktemp); trap 'rm -f "${cnf:-}" "$dump"' EXIT
cat > "$dump"
got=$(wc -c < "$dump")
if [ "$got" -ne "$size" ]; then echo "the dump was cut short: $got of $size bytes arrived; nothing was restored" >&2; exit 1; fi
`
)

// dumpSize is the size of the dump name in a snapshot.
func (r *runner) dumpSize(ctx context.Context, rp *repo, snap Snapshot, name string) (int64, error) {
	ls, err := r.restic(ctx, rp, []string{"ls", "--json", "--no-lock", snap.ID, "/" + name}, nil, nil)
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(ls.stdout), "\n") {
		var n struct {
			Path string `json:"path"`
			Size int64  `json:"size"`
		}
		if json.Unmarshal([]byte(line), &n) == nil && n.Path == "/"+name {
			return n.Size, nil
		}
	}
	return 0, fmt.Errorf("snapshot %s holds no %s", snap.ID, name)
}

// restoreDump streams a dump out of the snapshot into the restore command, in the service's
// running container.
func (r *runner) restoreDump(ctx context.Context, rp *repo, svc *domain.Service, snap Snapshot) error {
	c, err := r.runningContainer(ctx, svc)
	if err != nil {
		return err
	}
	_, name := dumpCommand(svc)
	size := int64(-1)
	if t := svc.Backup.Type; t == domain.BackupMySQL || t == domain.BackupMongo {
		if size, err = r.dumpSize(ctx, rp, snap, name); err != nil {
			return err
		}
	}
	cmd := restoreCommand(svc, size)
	ex, err := r.Engine.Exec(ctx, c.ID, engine.ExecOptions{Cmd: cmd, Stdin: true})
	if err != nil {
		return err
	}
	defer ex.Close()
	var stdout, stderr bytes.Buffer
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); _, _ = io.Copy(&stdout, ex.Stdout) }()
	go func() { defer wg.Done(); _, _ = io.Copy(&stderr, ex.Stderr) }()
	res, err := r.resticPipe(ctx, rp, []string{"dump", snap.ID, "/" + name}, nil, nil, ex.Stdin)
	_ = ex.Stdin.Close()
	wg.Wait()
	output := append(stdout.Bytes(), stderr.Bytes()...)
	code, werr := ex.Wait(ctx)
	switch {
	case err != nil:
		return err
	case res.code != 0:
		return fmt.Errorf("restic dump exited with code %d: %s", res.code, lastLines(res.stderr, 3))
	case werr != nil:
		return werr
	case code != 0:
		return fmt.Errorf("%s exited with code %d: %s", cmd[0], code, lastLines(output, 3))
	}
	return nil
}

// redisStaged is where a restore writes the RDB first, next to Redis's data.
const redisStaged = ".dockflow-restore.rdb"

// restoreRedis restores an RDB: Redis reads its data when it starts, so the dump becomes the
// stopped container's /data/dump.rdb. It is written beside it first, while Redis runs, then a
// hard link replaces dump.rdb at once: a restore cut at any point leaves Redis its own data or
// the whole snapshot.
func (r *runner) restoreRedis(ctx context.Context, rp *repo, svc *domain.Service, snap Snapshot) error {
	c, err := r.runningContainer(ctx, svc)
	if err != nil {
		return err
	}
	_, name := dumpCommand(svc)
	size, err := r.dumpSize(ctx, rp, snap, name)
	if err != nil {
		return err
	}
	pr, pw := io.Pipe()
	var dumpRes *resticRun
	var dumpErr error
	go func() {
		tw := tar.NewWriter(pw)
		if err := tw.WriteHeader(&tar.Header{Name: redisStaged, Mode: 0o644, Size: size, ModTime: snap.Time}); err != nil {
			pw.CloseWithError(err)
			return
		}
		dumpRes, dumpErr = r.resticPipe(ctx, rp, []string{"dump", snap.ID, "/" + name}, nil, nil, tw)
		if dumpErr == nil && dumpRes.code == 0 {
			dumpErr = tw.Close()
		}
		if dumpErr == nil && dumpRes.code != 0 {
			dumpErr = fmt.Errorf("restic dump exited with code %d: %s", dumpRes.code, lastLines(dumpRes.stderr, 3))
		}
		pw.CloseWithError(dumpErr)
	}()
	copyErr := r.Engine.CopyTo(ctx, c.ID, "/data", pr)
	_ = pr.CloseWithError(copyErr)
	switch {
	case dumpErr != nil:
		return dumpErr
	case copyErr != nil:
		return copyErr
	}

	rec := r.newBackupRun(svc)
	err = r.pause(ctx, svc, domain.QuiesceStop, "its restore", rec)
	if err == nil {
		var link bytes.Buffer
		tw := tar.NewWriter(&link)
		_ = tw.WriteHeader(&tar.Header{Typeflag: tar.TypeLink, Name: "dump.rdb", Linkname: redisStaged, Mode: 0o644, ModTime: snap.Time})
		_ = tw.Close()
		err = r.Engine.CopyTo(ctx, c.ID, "/data", &link)
	}
	if ferr := r.endFailed(ctx, rec); ferr != nil {
		err = errors.Join(err, fmt.Errorf("%s could not start again: %w; the next run or the watchdog starts it", svc.Name, ferr))
	}
	if err == nil {
		// the link is the data file's second name: one less copy of it on the disk
		if ex, xerr := r.Engine.Exec(ctx, c.ID, engine.ExecOptions{Cmd: []string{"rm", "-f", "/data/" + redisStaged}}); xerr == nil {
			_ = ex.Stdin.Close()
			_, _ = io.Copy(io.Discard, ex.Stdout)
			_, _ = ex.Wait(ctx)
			ex.Close()
		}
	}
	return err
}

// restoreVolumes restores the service's volumes: each one gets the snapshot's files, and loses
// those the snapshot does not have. The snapshot goes to staging volumes first, with the service
// running; then, the service stopped, each volume's files are replaced with its staging volume's.
// backup.json records each step: a restore cut before the copy leaves the volumes as they were,
// and one cut during the copy is completed before the service starts again.
func (r *runner) restoreVolumes(ctx context.Context, rp *repo, svc *domain.Service, snap Snapshot) error {
	rec := r.newBackupRun(svc)
	for i, target := range svc.Backup.Volumes {
		var mount *domain.Mount
		for _, m := range svc.Spec.Mounts {
			if m.Target == target && (m.Type == "volume" || m.Type == "bind") {
				mount = &m
			}
		}
		if mount == nil {
			return fmt.Errorf("%s mounts nothing at %s", svc.Name, target)
		}
		rec.Volumes = append(rec.Volumes, state.RestoreVolume{Type: mount.Type, Source: mount.Source, Staging: fmt.Sprintf("dockflow-restore-%s-%d", r.req.Run, i+1)})
	}
	err := r.app.SetBackupRun(*rec)
	for i, v := range rec.Volumes {
		if err != nil {
			break
		}
		target := "/data" + svc.Backup.Volumes[i]
		if err = r.Engine.CreateVolume(ctx, domain.Volume{Name: v.Staging}, ""); err != nil {
			break
		}
		var res *resticRun
		res, err = r.restic(ctx, rp, []string{"restore", snap.ID + ":" + target, "--target", target}, []domain.Mount{{Type: "volume", Source: v.Staging, Target: target}}, nil)
		if err == nil && res.code != 0 {
			err = fmt.Errorf("restic restore of %s exited with code %d: %s", svc.Backup.Volumes[i], res.code, lastLines(res.stderr, 3))
		}
	}
	if err == nil {
		syncDisks()
		err = r.pause(ctx, svc, domain.QuiesceStop, "its restore", rec)
	}
	if err == nil {
		rec.Copying = true
		if err = r.app.SetBackupRun(*rec); err != nil {
			rec.Copying = false
		}
	}
	if err != nil {
		// the volumes are untouched
		if ferr := r.endFailed(ctx, rec); ferr != nil {
			err = errors.Join(err, fmt.Errorf("%s could not start again: %w; the next run or the watchdog starts it", svc.Name, ferr))
		}
		return err
	}
	if err := r.endFailed(ctx, rec); err != nil {
		return fmt.Errorf("%w: %s stays stopped, its volumes partly replaced, until the next run or the watchdog finishes the restore", err, svc.Name)
	}
	return nil
}

// backupPrune applies a retention now, and reclaims the space of the forgotten snapshots.
func (r *runner) backupPrune(ctx context.Context) events.RunFinishedData {
	if r.req.Backup.Server {
		return r.pruneServer(ctx)
	}
	rel, err := r.currentRelease()
	if err != nil {
		return failed(err)
	}
	svcs, err := r.backedUp(rel)
	if err != nil {
		return failed(err)
	}
	rp, err := r.openRepo(ctx, false)
	if err != nil {
		return failed(err)
	}
	if rp == nil {
		r.result(map[string]any{"forgotten": 0})
		return events.RunFinishedData{Outcome: events.OutcomeSuccess}
	}
	defer rp.close()
	total := 0
	for i, svc := range svcs {
		// the space is reclaimed once, with the last service's retention
		keep := r.req.Backup.Keep
		if keep.Empty() {
			keep = svc.Backup.Keep
		}
		n, err := r.forgetKeep(ctx, rp, r.backupTags(svc.Name), keep, i == len(svcs)-1)
		if err != nil {
			return failed(errs.Newf("backup.retention", errs.ExitBackup, "the retention of %s failed: %v", svc.Name, err))
		}
		r.ev.Info(events.Log, fmt.Sprintf("%s: %d snapshots forgotten", svc.Name, n), map[string]any{"line": "forget " + svc.Name})
		total += n
	}
	r.result(map[string]any{"forgotten": total})
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}

// pruneServer applies a retention to the snapshots of the server's state.
func (r *runner) pruneServer(ctx context.Context) events.RunFinishedData {
	rp, err := r.openRepo(ctx, false)
	if err != nil {
		return failed(err)
	}
	if rp == nil {
		r.result(map[string]any{"forgotten": 0})
		return events.RunFinishedData{Outcome: events.OutcomeSuccess}
	}
	defer rp.close()
	n, err := r.forgetKeep(ctx, rp, r.serverTags(), r.req.Backup.Keep, true)
	if err != nil {
		return failed(errs.Newf("backup.retention", errs.ExitBackup, "the retention of the server's backups failed: %v", err))
	}
	r.ev.Info(events.Log, fmt.Sprintf("server: %d snapshots forgotten", n), map[string]any{"line": "forget server"})
	r.result(map[string]any{"forgotten": n})
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}
