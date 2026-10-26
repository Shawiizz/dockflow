package planner

import (
	"strings"
	"testing"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/testutil"
)

func app() domain.App {
	return domain.App{
		Name: "shop", Env: "production", Stack: "shop-production",
		Networks: []domain.Network{{Key: "default", Name: "shop-production_default"}},
		Volumes:  []domain.Volume{{Key: "pgdata", Name: "shop-production_pgdata"}},
		Services: []domain.Service{
			{Name: "db", Strategy: domain.StrategyStopFirst, Replicas: 1, Stateful: true,
				Spec: domain.ContainerSpec{Image: "postgres:17@sha256:aaaa", Restart: "unless-stopped"}},
			{Name: "web", Strategy: domain.StrategySwitch, Replicas: 2,
				Spec:      domain.ContainerSpec{Image: "whoami@sha256:bbbb", Env: []string{"A=1"}, Restart: "unless-stopped"},
				Routes:    []domain.Route{{Domains: []string{"shop.example.com"}, Path: "/", Port: 80, TLS: true}},
				DependsOn: []domain.Dependency{{Service: "db", Condition: "service_healthy"}}},
		},
	}
}

// deployed returns the actual state of a server running exactly a, as release seq.
func deployed(a domain.App, seq int) domain.Actual {
	act := domain.Actual{
		Services: map[string]domain.ActualService{},
		Networks: map[string]string{}, Volumes: map[string]bool{},
		Env: &domain.EnvRecord{Schema: 1, LastSeq: seq, Current: seq},
	}
	for _, n := range a.Networks {
		act.Networks[n.Name] = a.Stack
	}
	for _, v := range a.Volumes {
		act.Volumes[v.Name] = true
	}
	for _, s := range a.Services {
		s := s
		as := domain.ActualService{Name: s.Name, Release: seq, Hash: s.Hash(), Desired: &s}
		for i := 1; i <= s.Replicas; i++ {
			as.Containers = append(as.Containers, domain.ContainerInfo{
				ID: s.Name + string(rune('0'+i)), Name: domain.ContainerName(a.Stack, s.Name, seq, i),
				Service: s.Name, Release: seq, Hash: s.Hash(), State: "running", Health: "healthy",
			})
		}
		act.Services[s.Name] = as
	}
	return act
}

func TestFirstDeploy(t *testing.T) {
	p, err := Plan(app(), domain.Actual{})
	if err != nil {
		t.Fatal(err)
	}
	testutil.Golden(t, "first-deploy", p)
}

func TestNothingChanged(t *testing.T) {
	a := app()
	p, err := Plan(a, deployed(a, 3))
	if err != nil {
		t.Fatal(err)
	}
	if !p.Empty() {
		t.Fatalf("want an empty plan, got %+v", p.Actions)
	}
}

func TestImageChangeUpdatesOnlyThatService(t *testing.T) {
	old := app()
	a := app()
	a.Services[1].Spec.Image = "whoami@sha256:cccc"
	p, err := Plan(a, deployed(old, 3))
	if err != nil {
		t.Fatal(err)
	}
	testutil.Golden(t, "image-change", p)
}

func TestRemovedServiceAndCrashedContainer(t *testing.T) {
	old := app()
	act := deployed(old, 4)
	web := act.Services["web"]
	web.Containers[1].State = "exited"
	act.Services["web"] = web
	a := app()
	a.Services = a.Services[1:] // db removed
	a.Services[0].DependsOn = nil
	p, err := Plan(a, act)
	if err != nil {
		t.Fatal(err)
	}
	testutil.Golden(t, "removed-and-crashed", p)
}

func withJobs() domain.App {
	a := app()
	a.Services = append(a.Services,
		domain.Service{Name: "migrate", Job: domain.JobBefore, Replicas: 1,
			Spec: domain.ContainerSpec{Image: "whoami@sha256:bbbb", Command: []string{"migrate"}, Restart: "no"}},
		domain.Service{Name: "warm", Job: domain.JobAfter, Replicas: 1,
			Spec: domain.ContainerSpec{Image: "whoami@sha256:bbbb", Command: []string{"warm"}, Restart: "no"}},
	)
	a.Services[1].DependsOn = append(a.Services[1].DependsOn, domain.Dependency{Service: "migrate", Condition: "service_completed_successfully"})
	return a
}

func TestJobsRunAroundAChange(t *testing.T) {
	a := withJobs()
	a.Services[1].Spec.Image = "whoami@sha256:cccc"
	act := deployed(app(), 3) // jobs never run as services
	p, err := Plan(a, act)
	if err != nil {
		t.Fatal(err)
	}
	testutil.Golden(t, "jobs", p)
}

// On a first deploy, a migration that depends on the database runs once the database is up,
// and before the service that depends on it.
func TestBeforeJobRunsAfterItsDependencies(t *testing.T) {
	a := withJobs()
	a.Services[2].DependsOn = []domain.Dependency{{Service: "db", Condition: "service_healthy"}}
	p, err := Plan(a, domain.Actual{Services: map[string]domain.ActualService{}, Networks: map[string]string{}, Volumes: map[string]bool{}})
	if err != nil {
		t.Fatal(err)
	}
	testutil.Golden(t, "jobs-first-deploy", p)
	var order []string
	for _, a := range p.Actions {
		order = append(order, a.Kind+" "+a.Target)
	}
	got := strings.Join(order, ", ")
	want := "network.create shop-production_default, volume.create shop-production_pgdata, service.create db, job.run migrate, service.create web, routes.apply shop-production, job.run warm"
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestJobsDoNotRunWithoutAChange(t *testing.T) {
	p, err := Plan(withJobs(), deployed(app(), 3))
	if err != nil {
		t.Fatal(err)
	}
	if !p.Empty() {
		t.Fatalf("jobs alone must not make a plan: %+v", p.Actions)
	}
}

func TestUploadsRunFirstAndAlone(t *testing.T) {
	a := app()
	a.Uploads = []domain.Upload{{Dest: "volume:site", Volume: "shop-production_site", Manifest: "sha256:new"}}
	act := deployed(app(), 3)
	act.Uploads = map[string]string{"volume:site": "sha256:old"}
	p, err := Plan(a, act)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Actions) != 1 || p.Actions[0].Kind != domain.ActionUpload || p.Actions[0].Reason != "files changed" {
		t.Fatalf("want one upload, got %+v", p.Actions)
	}
	act.Uploads["volume:site"] = "sha256:new"
	if p, _ := Plan(a, act); !p.Empty() {
		t.Fatalf("applied uploads plan nothing: %+v", p.Actions)
	}
}

func TestRestartReplacesUnchangedServices(t *testing.T) {
	a := app()
	p, err := Plan(a, deployed(a, 3), "web")
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Actions) != 1 || p.Actions[0].Kind != domain.ActionUpdateService || p.Actions[0].Target != "web" || p.Actions[0].Reason != "restart" {
		t.Fatalf("want web restarted alone, got %+v", p.Actions)
	}
}

func TestMissingExternalNetwork(t *testing.T) {
	a := app()
	a.Networks = append(a.Networks, domain.Network{Key: "shared", Name: "shared", External: true})
	if _, err := Plan(a, domain.Actual{}); err == nil {
		t.Fatal("want an error")
	}
}

func TestFingerprintFollowsActualState(t *testing.T) {
	a := app()
	act := deployed(a, 3)
	f1 := Fingerprint(a, act)
	web := act.Services["web"]
	web.Containers[0].ID = "replaced"
	act.Services["web"] = web
	if f1 == Fingerprint(a, act) {
		t.Fatal("a changed container must change the fingerprint")
	}
}

// A network of the same name that the app does not own (a Swarm stack's, another Compose
// project's) is refused before anything changes; an external one is used as it is.
func TestForeignNetworkIsRefused(t *testing.T) {
	a := withJobs()
	name := a.Networks[0].Name
	act := domain.Actual{Services: map[string]domain.ActualService{}, Networks: map[string]string{name: ""}, Volumes: map[string]bool{}}
	_, err := Plan(a, act)
	if e, ok := errs.As(err); !ok || e.Code != "plan.network_foreign" {
		t.Fatalf("a network of no project must be refused, got %v", err)
	}
	act.Networks[name] = "other-production"
	if _, err := Plan(a, act); err == nil {
		t.Fatal("another project's network must be refused")
	}
	a.Networks[0].External = true
	if _, err := Plan(a, act); err != nil {
		t.Fatalf("an external network is used as it is: %v", err)
	}
}

// deploy --only web: web moves to the new version, db keeps the current release's spec although
// this version changes it too, and the migration web waits for comes from this version.
func TestOnlyDeploysTheNamedServices(t *testing.T) {
	cur := withJobs()
	next := withJobs()
	next.Services[0].Spec.Image = "postgres:18@sha256:dddd"
	next.Services[1].Spec.Image = "whoami@sha256:cccc"
	next.Services[2].Spec.Command = []string{"migrate", "--v2"}
	merged, err := Only(next, cur, []string{"web"})
	if err != nil {
		t.Fatal(err)
	}
	if db, _ := merged.Service("db"); db.Spec.Image != cur.Services[0].Spec.Image {
		t.Fatalf("db must keep the current release's image, got %s", db.Spec.Image)
	}
	if m, _ := merged.Service("migrate"); m.Spec.Command[1] != "--v2" {
		t.Fatalf("jobs come from the deployed version: %v", m.Spec.Command)
	}
	p, err := Plan(merged, deployed(app(), 3))
	if err != nil {
		t.Fatal(err)
	}
	testutil.Golden(t, "only", p)

	if _, err := Only(next, cur, []string{"nope"}); err == nil {
		t.Fatal("an unknown service must be refused")
	}
	// on a server without db, web cannot go alone
	if _, err := Only(next, domain.App{Name: "shop", Env: "production", Stack: "shop-production"}, []string{"web"}); err == nil {
		t.Fatal("a dependency that is not deployed must be refused")
	}
	// a service the current release has and this version removed is kept
	next.Services = append(next.Services[:0:0], next.Services[1:]...)
	next.Services[0].DependsOn = []domain.Dependency{{Service: "migrate", Condition: "service_completed_successfully"}}
	merged, err = Only(next, cur, []string{"web"})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := merged.Service("db"); !ok {
		t.Fatal("--only never removes a service it does not name")
	}
}
