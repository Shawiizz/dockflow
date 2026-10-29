//go:build linux

package agent

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/state"
)

// The fault-injection harness of backups (vision goal 4): a backup, a restore or a prune is cut,
// or one of its changes fails, at every change it makes to Docker, to restic and to the state
// files in turn. Then the watchdog and the next run recover, and the services must run, on their
// data or on the whole snapshot, and every snapshot left must be complete and consistent.
//
// The fake engine runs a fake restic, and fake database tools, in the containers the agent
// creates and execs into: the seam is the Engine port, as for deploys.

// partial is the content of a volume or a database that a copy or a restore left half-done.
const partial = "PARTIAL"

// dumpOf is the dump of a database holding v; a dump cut short is not one.
func dumpOf(v string) string { return "DUMP(" + v + ")" }

func undump(s string) (string, bool) {
	if v, ok := strings.CutPrefix(s, "DUMP("); ok && strings.HasSuffix(v, ")") {
		return strings.TrimSuffix(v, ")"), true
	}
	return "", false
}

// bufPipe is a stream whose writer never blocks: a container's output, or its stdin, whose
// reader may be gone.
type bufPipe struct {
	mu     sync.Mutex
	cond   *sync.Cond
	buf    bytes.Buffer
	closed bool
	// before runs once, before the first read: a helper that runs to its end as it is read.
	before func()
	once   sync.Once
}

func newPipe() *bufPipe {
	p := &bufPipe{}
	p.cond = sync.NewCond(&p.mu)
	return p
}

func (p *bufPipe) Write(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return 0, io.ErrClosedPipe
	}
	p.buf.Write(b)
	p.cond.Broadcast()
	return len(b), nil
}

func (p *bufPipe) Read(b []byte) (int, error) {
	if p.before != nil {
		p.once.Do(p.before)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for p.buf.Len() == 0 && !p.closed {
		p.cond.Wait()
	}
	if p.buf.Len() == 0 {
		return 0, io.EOF
	}
	return p.buf.Read(b)
}

func (p *bufPipe) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true
	p.cond.Broadcast()
	return nil
}

// settle does what Docker does when an agent dies: it closes the stdins the agent held. What the
// containers and commands then do on their own ends before anything else looks.
func (p *proc) settle(t *testing.T) {
	p.mu.Lock()
	streams := p.streams
	p.mu.Unlock()
	for _, s := range streams {
		_ = s.Close()
	}
	done := make(chan struct{})
	go func() { p.bg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the containers of a dead agent do not end")
	}
}

func (p *proc) attached(c io.Closer) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.streams = append(p.streams, c)
}

// backupWorld is what backups see of the server.
type backupWorld struct {
	// data are the contents of volumes and bind mounts, by source; db the databases, by service;
	// files the files written into containers, by container and path.
	data  map[string]string
	db    map[string]string
	files map[string]map[string]string
	// redis are the services whose data is the RDB file in /data, loaded at start and saved at
	// stop.
	redis    map[string]bool
	quiesced map[string]bool
	repo     bool
	snaps    []*fakeSnap
	nextSnap int
	helpers  map[string]*fakeHelper
	// damage lists the services that started on a volume or a database left half-restored.
	damage []string
}

type fakeSnap struct {
	id    string
	tags  []string
	paths []string
	time  time.Time
	files map[string]string
	// ok is a complete dump, or volumes copied while their service did not write.
	ok bool
}

func (s *fakeSnap) has(tags string) bool {
	for _, t := range strings.Split(tags, ",") {
		if !slices.Contains(s.tags, t) {
			return false
		}
	}
	return true
}

// fakeHelper is a one-off container the agent runs: restic, or a restore's copy.
type fakeHelper struct {
	e                     *fakeEngine
	id                    string
	spec                  domain.ContainerSpec
	args                  []string
	stdin, stdout, stderr *bufPipe
	input                 []byte
	once                  sync.Once
	done                  chan struct{}
	code                  int
	// effect is what the helper does once it has run, under the world's lock.
	effect func(*fakeHelper)
}

// end runs the helper to its end, or kills it before: its effect happens, or not at all.
func (h *fakeHelper) end(killed bool) {
	h.once.Do(func() {
		w := h.e.w
		w.mu.Lock()
		if killed {
			h.code = 137
		} else if h.effect != nil {
			h.effect(h)
		}
		if c := w.find(h.id); c != nil {
			c.State = "exited"
		}
		w.mu.Unlock()
		_ = h.stdout.Close()
		_ = h.stderr.Close()
		_ = h.stdin.Close()
		close(h.done)
	})
}

func (h *fakeHelper) stdinMode() bool {
	return slices.Contains(h.args, "--stdin-from-command") || slices.Contains(h.args, "--stdin")
}

func (h *fakeHelper) wait() int {
	if !h.stdinMode() {
		h.end(false)
	}
	<-h.done
	return h.code
}

func (h *fakeHelper) out(s string) { _, _ = h.stdout.Write([]byte(s)) }

func (h *fakeHelper) fail(code int, msg string) {
	h.code = code
	_, _ = h.stderr.Write([]byte(msg + "\n"))
}

// flag is the value of a restic flag.
func (h *fakeHelper) flag(name string) string {
	if i := slices.Index(h.args, name); i >= 0 && i+1 < len(h.args) {
		return h.args[i+1]
	}
	return ""
}

// positional are restic's arguments that are not flags, up to --.
func (h *fakeHelper) positional() []string {
	valued := []string{"--host", "--tag", "--stdin-filename", "--exclude", "--target", "--keep-last", "--keep-hourly", "--keep-daily", "--keep-weekly", "--keep-monthly"}
	var out []string
	for i := 1; i < len(h.args); i++ {
		a := h.args[i]
		switch {
		case a == "--":
			return out
		case slices.Contains(valued, a):
			i++
		case strings.HasPrefix(a, "-"):
		default:
			out = append(out, a)
		}
	}
	return out
}

// mountAt is the source mounted at target in the helper.
func (h *fakeHelper) mountAt(target string) string {
	for _, m := range h.spec.Mounts {
		if m.Target == target {
			return m.Source
		}
	}
	return ""
}

func (e *fakeEngine) helperOf(id string) *fakeHelper {
	e.w.mu.Lock()
	defer e.w.mu.Unlock()
	if e.w.bk == nil {
		return nil
	}
	if c := e.w.find(id); c != nil {
		return e.w.bk.helpers[c.ID]
	}
	return nil
}

func (e *fakeEngine) createdLocked(id string, spec domain.ContainerSpec) {
	bk := e.w.bk
	if bk == nil || len(spec.Entrypoint) < 3 {
		return
	}
	h := &fakeHelper{e: e, id: id, spec: spec, stdin: newPipe(), stdout: newPipe(), stderr: newPipe(), done: make(chan struct{})}
	switch {
	case strings.Contains(spec.Entrypoint[2], "restic"):
		h.args = spec.Command
	case spec.Entrypoint[2] == copyScript:
	default:
		return
	}
	bk.helpers[id] = h
}

func (e *fakeEngine) startedLocked(c *engine.Container) {
	bk := e.w.bk
	if bk == nil {
		return
	}
	if h := bk.helpers[c.ID]; h != nil {
		e.startHelperLocked(h)
		return
	}
	if c.Labels[domain.LabelKind] != domain.KindService {
		return
	}
	damaged := bk.db[c.Service] == partial
	for _, m := range e.w.specs[c.ID].Mounts {
		damaged = damaged || bk.data[m.Source] == partial
	}
	if bk.redis[c.Service] {
		if rdb, ok := bk.files[c.ID]["/data/dump.rdb"]; ok {
			if v, ok := undump(rdb); ok {
				bk.db[c.Service] = v
			} else {
				damaged = true
			}
		}
	}
	if damaged {
		bk.damage = append(bk.damage, c.Service)
	}
}

func (e *fakeEngine) stoppedLocked(c *engine.Container) {
	bk := e.w.bk
	if bk == nil || c.State != "running" {
		return
	}
	if bk.redis[c.Service] {
		// Redis saves its data when it stops
		if bk.files[c.ID] == nil {
			bk.files[c.ID] = map[string]string{}
		}
		bk.files[c.ID]["/data/dump.rdb"] = dumpOf(bk.db[c.Service])
	}
}

func (e *fakeEngine) removedLocked(c *engine.Container) {
	bk := e.w.bk
	if bk == nil {
		return
	}
	if h := bk.helpers[c.ID]; h != nil {
		delete(bk.helpers, c.ID)
		// a forced removal kills it: the end must not wait for the world's lock, held here
		go h.end(true)
	}
}

// startHelperLocked starts a helper: a copy, or restic's command.
func (e *fakeEngine) startHelperLocked(h *fakeHelper) {
	bk := e.w.bk
	if h.args == nil {
		to, from := h.mountAt("/to"), h.mountAt("/from")
		bk.data[to] = partial
		h.effect = func(h *fakeHelper) { bk.data[to] = bk.data[from] }
		h.stdout.before = func() { h.end(false) }
		return
	}
	h.effect = func(h *fakeHelper) { e.resticLocked(h) }
	if h.stdinMode() {
		e.p.bg.Add(1)
		go func() {
			defer e.p.bg.Done()
			h.input, _ = io.ReadAll(h.stdin)
			h.end(false)
		}()
		return
	}
	if h.args[0] == "restore" {
		bk.data[h.mountAt(h.flag("--target"))] = partial
	}
	h.stdout.before = func() { h.end(false) }
}

// writingLocked tells whether a service that is not quiesced runs on source.
func (e *fakeEngine) writingLocked(source string) bool {
	for _, c := range e.w.containers {
		if c.State != "running" || c.Labels[domain.LabelKind] != domain.KindService || e.w.bk.quiesced[c.Service] {
			continue
		}
		for _, m := range e.w.specs[c.ID].Mounts {
			if m.Source == source {
				return true
			}
		}
	}
	return false
}

func (bk *backupWorld) snap(id string) *fakeSnap {
	for _, s := range bk.snaps {
		if strings.HasPrefix(s.id, id) {
			return s
		}
	}
	return nil
}

// resticLocked is restic, for the commands the agent runs.
func (e *fakeEngine) resticLocked(h *fakeHelper) {
	bk := e.w.bk
	pos := h.positional()
	if h.args[0] != "init" && !bk.repo {
		h.fail(resticNoRepository, "Fatal: repository does not exist")
		return
	}
	switch h.args[0] {
	case "init":
		if bk.repo {
			h.fail(1, "Fatal: create repository at /repo failed: config file already exists")
			return
		}
		bk.repo = true
	case "backup":
		s := &fakeSnap{tags: strings.Split(h.flag("--tag"), ","), files: map[string]string{}, ok: true}
		if h.stdinMode() {
			if slices.Contains(h.args, "--stdin-from-command") {
				marker := h.args[len(h.args)-1]
				if _, err := os.Stat(filepath.Join(h.mountAt("/run/backup"), filepath.Base(marker))); err != nil {
					h.fail(1, "Fatal: unable to save snapshot: command exited with code 1")
					return
				}
			}
			name := "/" + h.flag("--stdin-filename")
			s.paths, s.files[name] = []string{name}, string(h.input)
			_, s.ok = undump(string(h.input))
		} else {
			for _, path := range pos {
				src := h.mountAt(path)
				s.paths, s.files[path] = append(s.paths, path), bk.data[src]
				if bk.data[src] == partial || e.writingLocked(src) {
					s.ok = false
				}
			}
		}
		bk.nextSnap++
		s.id = fmt.Sprintf("%08x", bk.nextSnap) + strings.Repeat("0", 56)
		s.time = clock.Add(time.Duration(bk.nextSnap) * time.Hour)
		bk.snaps = append(bk.snaps, s)
		h.out(fmt.Sprintf(`{"message_type":"summary","snapshot_id":%q,"data_added":10,"total_duration":1}`+"\n", s.id))
	case "forget":
		var removed []string
		if len(pos) > 0 {
			removed = append(removed, pos...)
		} else {
			var group []*fakeSnap
			for _, s := range bk.snaps {
				if s.has(h.flag("--tag")) {
					group = append(group, s)
				}
			}
			sort.SliceStable(group, func(i, j int) bool { return group[i].time.After(group[j].time) })
			kept := map[*fakeSnap]bool{}
			for i := range group {
				if n, _ := strconv.Atoi(h.flag("--keep-last")); i < n {
					kept[group[i]] = true
				}
			}
			week := func(t time.Time) string { y, w := t.ISOWeek(); return fmt.Sprint(y, w) }
			layout := func(l string) func(time.Time) string { return func(t time.Time) string { return t.Format(l) } }
			for flag, bucket := range map[string]func(time.Time) string{
				"--keep-hourly": layout("2006-01-02 15"), "--keep-daily": layout("2006-01-02"), "--keep-weekly": week, "--keep-monthly": layout("2006-01"),
			} {
				n, _ := strconv.Atoi(h.flag(flag))
				last := ""
				for _, s := range group {
					if k := bucket(s.time); k != last && n > 0 {
						kept[s], last = true, k
						n--
					}
				}
			}
			for _, s := range group {
				if !kept[s] {
					removed = append(removed, s.id)
				}
			}
		}
		bk.snaps = slices.DeleteFunc(bk.snaps, func(s *fakeSnap) bool {
			return slices.ContainsFunc(removed, func(id string) bool { return strings.HasPrefix(s.id, id) })
		})
		b, _ := json.Marshal([]map[string]any{{"remove": removed}})
		h.out(string(b) + "\n")
	case "snapshots":
		var out []map[string]any
		for _, s := range bk.snaps {
			if s.has(h.flag("--tag")) {
				out = append(out, map[string]any{"short_id": s.id[:8], "time": s.time, "tags": s.tags})
			}
		}
		b, _ := json.Marshal(out)
		h.out(string(b))
	case "check":
	case "ls", "dump":
		s := bk.snap(pos[0])
		if s == nil {
			h.fail(1, "no snapshot "+pos[0])
			return
		}
		content, ok := s.files[pos[1]]
		if !ok {
			h.fail(1, "no file "+pos[1])
			return
		}
		if h.args[0] == "ls" {
			h.out(fmt.Sprintf(`{"path":%q,"size":%d}`+"\n", pos[1], len(content)))
			return
		}
		h.out(content)
	case "restore":
		id, path, _ := strings.Cut(pos[0], ":")
		s := bk.snap(id)
		if s == nil {
			h.fail(1, "no snapshot "+id)
			return
		}
		bk.data[h.mountAt(h.flag("--target"))] = s.files[path]
	default:
		h.fail(1, "unknown command "+h.args[0])
	}
}

func (e *fakeEngine) Attach(_ context.Context, id string, _ bool) (*engine.Attached, error) {
	e.p.look()
	h := e.helperOf(id)
	if h == nil {
		return nil, noSuch(id)
	}
	e.p.attached(h.stdin)
	return &engine.Attached{Stdin: h.stdin, Stdout: h.stdout, Stderr: h.stderr, Close: func() { _ = h.stdin.Close() }}, nil
}

// Exec runs the database tools and the quiesce commands of the test app.
func (e *fakeEngine) Exec(_ context.Context, id string, o engine.ExecOptions) (*engine.Exec, error) {
	var ex *engine.Exec
	err := e.p.change("exec "+o.Cmd[0]+" in "+e.name(id), func() error {
		e.w.mu.Lock()
		defer e.w.mu.Unlock()
		c := e.w.find(id)
		if c == nil || c.State != "running" {
			return errs.New("engine.api", errs.ExitInternal, "container "+id+" is not running")
		}
		run := e.command(c, o.Cmd)
		stdin, stdout, stderr := newPipe(), newPipe(), newPipe()
		done := make(chan struct{})
		code := 0
		e.p.attached(stdin)
		e.p.bg.Add(1)
		go func() {
			defer e.p.bg.Done()
			in, _ := io.ReadAll(stdin)
			e.w.mu.Lock()
			out, n := run(string(in))
			e.w.mu.Unlock()
			_, _ = stdout.Write([]byte(out))
			code = n
			_ = stdout.Close()
			_ = stderr.Close()
			close(done)
		}()
		ex = &engine.Exec{
			Attached: engine.Attached{Stdin: stdin, Stdout: stdout, Stderr: stderr, Close: func() { _ = stdin.Close() }},
			Wait:     func(context.Context) (int, error) { <-done; return code, nil },
		}
		return nil
	})
	if err != nil {
		if ex != nil {
			// the connection is gone: the command's stdin closes
			_ = ex.Stdin.Close()
		}
		return nil, err
	}
	return ex, nil
}

// command is what a command run in a service's container does with its stdin, under the world's
// lock.
func (e *fakeEngine) command(c *engine.Container, cmd []string) func(in string) (string, int) {
	bk, svc := e.w.bk, c.Service
	script := ""
	if cmd[0] == "sh" && len(cmd) > 2 {
		script = cmd[2]
	}
	switch {
	case cmd[0] == "save-off" || cmd[0] == "save-on":
		return func(string) (string, int) { bk.quiesced[svc] = cmd[0] == "save-off"; return "", 0 }
	case cmd[0] == "pg_dump", strings.Contains(script, "mariadb-dump"), strings.Contains(script, "redis-cli"):
		return func(string) (string, int) { return dumpOf(bk.db[svc]), 0 }
	case cmd[0] == "pg_restore":
		// one transaction: all of the dump, or nothing
		return func(in string) (string, int) {
			if v, ok := undump(in); ok {
				bk.db[svc] = v
				return "", 0
			}
			return "", 1
		}
	case strings.Contains(script, "mariadb"):
		return func(in string) (string, int) {
			v, ok := undump(in)
			if strings.Contains(script, "wc -c") {
				// the dump is staged, its size checked, before the client reads it
				if size, _ := strconv.Atoi(cmd[4]); len(in) != size || !ok {
					return "", 1
				}
			}
			switch {
			case ok:
				bk.db[svc] = v
				return "", 0
			case in != "":
				// the client changed the tables it read before the dump ended
				bk.db[svc] = partial
			}
			return "", 1
		}
	case cmd[0] == "rm":
		return func(string) (string, int) { delete(bk.files[c.ID], cmd[len(cmd)-1]); return "", 0 }
	}
	return func(string) (string, int) { return "", 0 }
}

func (e *fakeEngine) CopyTo(_ context.Context, id, dir string, r io.Reader) error {
	e.p.look()
	type entry struct{ name, content, link string }
	var entries []entry
	var readErr error
	tr := tar.NewReader(r)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			readErr = err
			break
		}
		if hdr.Typeflag == tar.TypeLink {
			entries = append(entries, entry{name: hdr.Name, link: hdr.Linkname})
			continue
		}
		b, err := io.ReadAll(tr)
		entries = append(entries, entry{name: hdr.Name, content: string(b)})
		if err != nil {
			readErr = err
			break
		}
	}
	return e.p.change("copy to "+e.name(id), func() error {
		e.w.mu.Lock()
		defer e.w.mu.Unlock()
		c := e.w.find(id)
		if c == nil {
			return noSuch(id)
		}
		files := e.w.bk.files[c.ID]
		if files == nil {
			files = map[string]string{}
			e.w.bk.files[c.ID] = files
		}
		for _, en := range entries {
			if en.link != "" {
				target, ok := files[dir+"/"+en.link]
				if !ok {
					return errs.New("engine.api", errs.ExitInternal, "no such file "+en.link)
				}
				files[dir+"/"+en.name] = target
				continue
			}
			// what arrived is written, even when the archive was cut short
			files[dir+"/"+en.name] = en.content
		}
		return readErr
	})
}

func (e *fakeEngine) RemoveVolume(_ context.Context, name string) error {
	return e.p.change("remove volume "+name, func() error {
		e.w.mu.Lock()
		defer e.w.mu.Unlock()
		delete(e.w.volumes, name)
		if e.w.bk != nil {
			delete(e.w.bk.data, name)
		}
		return nil
	})
}

// backupApp is an app whose every kind of backup is tried: a Postgres and a MySQL dump, Redis,
// a volume backed up stopped, and one quiesced by commands.
func backupApp() domain.App {
	network := testStack + "_default"
	svc := func(name string, b *domain.Backup, volume string) domain.Service {
		s := domain.Service{
			Name: name, Strategy: domain.StrategyStopFirst, Replicas: 1, Stateful: true, Backup: b,
			Spec: domain.ContainerSpec{
				Image: "registry.test/" + name + "@sha256:" + strings.Repeat("a", 64), Restart: "unless-stopped",
				Networks: []domain.Attachment{{Network: network, Aliases: []string{name}}},
			},
		}
		if volume != "" {
			s.Spec.Mounts = []domain.Mount{{Type: "volume", Source: testStack + "_" + volume, Target: "/data"}}
		}
		return s
	}
	return domain.App{
		Name: "shop", Env: "production", Stack: testStack,
		Networks: []domain.Network{{Key: "default", Name: network}},
		Volumes:  []domain.Volume{{Key: "files", Name: testStack + "_files"}, {Key: "world", Name: testStack + "_world"}},
		Services: []domain.Service{
			svc("db", &domain.Backup{Type: domain.BackupPostgres}, ""),
			svc("maria", &domain.Backup{Type: domain.BackupMySQL}, ""),
			svc("cache", &domain.Backup{Type: domain.BackupRedis}, ""),
			svc("files", &domain.Backup{Type: domain.BackupVolume, Volumes: []string{"/data"}, Quiesce: domain.Quiesce{Mode: domain.QuiesceStop}}, "files"),
			svc("game", &domain.Backup{Type: domain.BackupVolume, Volumes: []string{"/data"}, Quiesce: domain.Quiesce{
				Mode: domain.QuiesceExec, Pre: []string{"save-off"}, Post: []string{"save-on"},
			}}, "world"),
		},
	}
}

var backupServices = []string{"db", "maria", "cache", "files", "game"}

// newBackupHarness is a server where backupApp runs, with its data at v1.
func newBackupHarness(t *testing.T) *harness {
	backupTmp = t.TempDir()
	h := newHarness(t)
	h.w.bk = &backupWorld{
		data: map[string]string{}, db: map[string]string{}, files: map[string]map[string]string{},
		redis: map[string]bool{"cache": true}, quiesced: map[string]bool{}, helpers: map[string]*fakeHelper{},
	}
	app := backupApp()
	if res, _ := h.deploy(app, 0, ""); res == nil || res.Outcome != events.OutcomeSuccess {
		t.Fatalf("the deploy failed: %+v", res)
	}
	h.setData("v1")
	return h
}

// setData sets the data of every service.
func (h *harness) setData(v string) {
	h.w.mu.Lock()
	defer h.w.mu.Unlock()
	for _, s := range []string{"db", "maria", "cache"} {
		h.w.bk.db[s] = v
	}
	h.w.bk.data[testStack+"_files"] = v
	h.w.bk.data[testStack+"_world"] = v
}

// dataOf is a service's data.
func (h *harness) dataOf(service string) string {
	h.w.mu.Lock()
	defer h.w.mu.Unlock()
	switch service {
	case "files":
		return h.w.bk.data[testStack+"_files"]
	case "game":
		return h.w.bk.data[testStack+"_world"]
	}
	return h.w.bk.db[service]
}

func (h *harness) backup(op string, b *BackupRequest, at int, how string) (*events.RunFinishedData, *proc) {
	if b == nil {
		b = &BackupRequest{}
	}
	return h.do(Request{Op: op, Backup: b}, at, how)
}

// snapsOf are the IDs of a service's snapshots, oldest first.
func (h *harness) snapsOf(service string) []string {
	h.w.mu.Lock()
	defer h.w.mu.Unlock()
	var out []string
	for _, s := range h.w.bk.snaps {
		if s.has("service=" + service) {
			out = append(out, s.id)
		}
	}
	return out
}

// checkBackups asserts what must hold once the watchdog or the next run recovered: every
// service runs, writes, on undamaged data; every snapshot is complete; nothing of a run is left.
func (h *harness) checkBackups(label string) {
	t := h.t
	t.Helper()
	fail := func(format string, args ...any) {
		t.Helper()
		t.Errorf("%s: %s", label, fmt.Sprintf(format, args...))
	}
	st, err := state.Open(h.root, "check")
	if err != nil {
		t.Fatal(err)
	}
	app, _ := st.App(testStack)
	if rec, err := app.BackupRun(); rec != nil || err != nil {
		fail("backup.json is left: %+v %v", rec, err)
	}
	_ = filepath.WalkDir(h.root, func(path string, d fs.DirEntry, err error) error {
		if err == nil && strings.Contains(d.Name(), ".tmp-") {
			fail("a state file is left half-written: %s", path)
		}
		return nil
	})
	h.w.mu.Lock()
	defer h.w.mu.Unlock()
	bk := h.w.bk
	if len(bk.damage) > 0 {
		fail("started on damaged data: %v", bk.damage)
	}
	running := map[string]int{}
	for _, c := range h.w.containers {
		switch c.Labels[domain.LabelKind] {
		case domain.KindService:
			if c.State == "running" {
				running[c.Service]++
			}
		case domain.KindHelper:
			if c.State == "running" {
				fail("%s still runs", c.Name)
			}
		}
	}
	for _, s := range backupServices {
		if running[s] != 1 {
			fail("%s runs %d containers", s, running[s])
		}
		if bk.quiesced[s] {
			fail("the writes of %s were not resumed", s)
		}
	}
	for _, s := range bk.snaps {
		if !s.ok {
			fail("snapshot %s (%v) is not complete: %v", s.id[:8], s.tags, s.files)
		}
	}
	for v := range h.w.volumes {
		if strings.HasPrefix(v, "dockflow-restore-") {
			fail("the staging volume %s is left", v)
		}
	}
}

// recoverAll runs the watchdog, then the next run's recovery, checking after each.
func (h *harness) recoverAll(label string) {
	h.t.Helper()
	h.watchdog()
	h.checkBackups(label + ", after the watchdog")
	if err := h.recoverNow(); err != nil {
		h.t.Errorf("%s: the next run cannot recover: %v", label, err)
	}
	h.checkBackups(label + ", after the next run")
}

// tryAll calls one with every change in turn going wrong in every way, and returns how many
// changes were tried.
func tryAll(t *testing.T, one func(at int, how string) bool) {
	for _, how := range []string{cut, refuse, lose} {
		tried := 0
		for at := 1; at < 300; at++ {
			if !one(at, how) {
				break
			}
			tried++
		}
		if tried < 5 {
			t.Errorf("%s: only %d changes tried", how, tried)
		}
	}
}

func outcome(res *events.RunFinishedData, p *proc, at int, how string) string {
	o := "died"
	if res != nil {
		o = res.Outcome
		if res.Error != nil {
			o += " (" + res.Error.Message + ")"
		}
	}
	return fmt.Sprintf("%s at change %d (%s), %s", how, at, p.trail[at-1], o)
}

func TestBackupGoesWrongAtEveryChange(t *testing.T) {
	tryAll(t, func(at int, how string) bool {
		h := newBackupHarness(t)
		if res, _ := h.backup(OpBackupRun, nil, 0, ""); res.Outcome != events.OutcomeSuccess {
			t.Fatalf("the first backup failed: %+v", res.Error)
		}
		h.setData("v2")
		res, p := h.backup(OpBackupRun, nil, at, how)
		if p.calls < at {
			return false
		}
		label := outcome(res, p, at, how)
		h.recoverAll(label)
		if res != nil && res.Outcome == events.OutcomeSuccess {
			for _, s := range backupServices {
				if n := len(h.snapsOf(s)); n != 2 {
					t.Errorf("%s: %s has %d snapshots after a backup that succeeded", label, s, n)
				}
			}
		}
		if res, _ := h.backup(OpBackupRun, nil, 0, ""); res.Outcome != events.OutcomeSuccess {
			t.Errorf("%s: the next backup failed: %+v", label, res.Error)
		}
		h.checkBackups(label + ", after the next backup")
		return true
	})
}

func TestRestoreGoesWrongAtEveryChange(t *testing.T) {
	for _, service := range []string{"db", "maria", "cache", "files"} {
		t.Run(service, func(t *testing.T) {
			tryAll(t, func(at int, how string) bool {
				h := newBackupHarness(t)
				if res, _ := h.backup(OpBackupRun, nil, 0, ""); res.Outcome != events.OutcomeSuccess {
					t.Fatalf("the backup failed: %+v", res.Error)
				}
				h.setData("v2")
				res, p := h.backup(OpBackupRestore, &BackupRequest{Service: service}, at, how)
				if p.calls < at {
					return false
				}
				label := outcome(res, p, at, how)
				h.recoverAll(label)
				got := h.dataOf(service)
				switch {
				case got != "v1" && got != "v2":
					t.Errorf("%s: %s holds %q: neither its data nor the snapshot's", label, service, got)
				case res != nil && res.Outcome == events.OutcomeSuccess && got != "v1":
					t.Errorf("%s: %s holds %q after a restore that succeeded", label, service, got)
				}
				if res, _ := h.backup(OpBackupRestore, &BackupRequest{Service: service}, 0, ""); res.Outcome != events.OutcomeSuccess {
					t.Errorf("%s: the next restore failed: %+v", label, res.Error)
				}
				if got := h.dataOf(service); got != "v1" {
					t.Errorf("%s: %s holds %q after the next restore", label, service, got)
				}
				h.checkBackups(label + ", after the next restore")
				return true
			})
		})
	}
}

func TestBackupPruneGoesWrongAtEveryChange(t *testing.T) {
	tryAll(t, func(at int, how string) bool {
		h := newBackupHarness(t)
		for i := range 4 {
			h.setData("v" + strconv.Itoa(i))
			if res, _ := h.backup(OpBackupRun, nil, 0, ""); res.Outcome != events.OutcomeSuccess {
				t.Fatalf("backup %d failed: %+v", i, res.Error)
			}
		}
		keep := map[string][]string{}
		for _, s := range backupServices {
			snaps := h.snapsOf(s)
			keep[s] = snaps[len(snaps)-2:]
		}
		res, p := h.backup(OpBackupPrune, &BackupRequest{Keep: &domain.Keep{Last: 2}}, at, how)
		if p.calls < at {
			return false
		}
		label := outcome(res, p, at, how)
		h.recoverAll(label)
		for _, s := range backupServices {
			for _, id := range keep[s] {
				if !slices.Contains(h.snapsOf(s), id) {
					t.Errorf("%s: %s lost snapshot %s, which keep-last 2 keeps", label, s, id[:8])
				}
			}
		}
		if res, _ := h.backup(OpBackupPrune, &BackupRequest{Keep: &domain.Keep{Last: 2}}, 0, ""); res.Outcome != events.OutcomeSuccess {
			t.Errorf("%s: the next prune failed: %+v", label, res.Error)
		}
		for _, s := range backupServices {
			if got := h.snapsOf(s); !slices.Equal(got, keep[s]) {
				t.Errorf("%s: %s keeps %v after the next prune", label, s, got)
			}
		}
		return true
	})
}
