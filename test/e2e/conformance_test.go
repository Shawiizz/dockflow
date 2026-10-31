//go:build e2e

package e2e

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"

	"github.com/Shawiizz/dockflow/internal/compose"
)

// conformance are Compose files that Dockflow must run as docker compose up does: the same
// container configuration, compared field by field (ADR-0005). Each one exercises keys whose
// translation to the Engine API has edge cases.
var conformance = []struct{ name, compose string }{
	{"basics", `services:
  app:
    image: ALPINE
    entrypoint: ["/bin/sh", "-c"]
    command: ["echo started; exec sleep infinity"]
    user: "1000:1000"
    working_dir: /tmp
    hostname: app-host
    domainname: example.test
    labels:
      com.example.team: core
      com.example.empty: ""
    environment:
      - PLAIN=1
      - EMPTY=
      - WITH_EQUALS=a=b
    stop_signal: SIGINT
    stop_grace_period: 7s
    tty: true
    stdin_open: true
    init: true
    read_only: true
    restart: always
  map-env:
    image: ALPINE
    command: sleep infinity
    environment:
      FROM_MAP: "yes"
      NUMBER: 3
      UNSET:
    restart: "no"
`},
	{"resources", `services:
  app:
    image: ALPINE
    command: sleep infinity
    mem_limit: 64m
    mem_reservation: 32m
    memswap_limit: 128m
    cpus: 0.5
    cpu_shares: 512
    pids_limit: 100
    shm_size: 16m
    oom_score_adj: 100
    ulimits:
      nofile:
        soft: 1024
        hard: 2048
      nproc: 512
    restart: unless-stopped
  deploy-limits:
    image: ALPINE
    command: sleep infinity
    deploy:
      resources:
        limits:
          memory: 48m
          cpus: "0.25"
          pids: 50
        reservations:
          memory: 16m
      replicas: 1
      update_config:
        order: start-first
      restart_policy:
        condition: on-failure
        max_attempts: 3
`},
	{"security", `services:
  app:
    image: ALPINE
    command: sleep infinity
    cap_add: [NET_ADMIN, SYS_PTRACE]
    cap_drop: [MKNOD]
    security_opt: ["no-new-privileges:true"]
    group_add: ["100"]
    sysctls:
      net.core.somaxconn: 1024
    extra_hosts:
      - "api.internal:10.1.2.3"
      - "other.internal=10.1.2.4"
    dns: [1.1.1.1]
    dns_search: [example.test]
    dns_opt: ["ndots:2"]
    tmpfs:
      - /run/cache:size=1m
    ipc: shareable
    restart: always
  privileged:
    image: ALPINE
    command: sleep infinity
    privileged: true
    restart: always
`},
	{"networks", `services:
  app:
    image: ALPINE
    command: sleep infinity
    expose: ["8080", "9000-9001/udp"]
    ports:
      - "127.0.0.1:18081:8080"
      - "18082:9000/udp"
    networks:
      front:
        aliases: [app-front, api]
        priority: 10
        mac_address: "de:ad:be:ef:00:01"
        link_local_ips: [169.254.10.10]
      back:
        ipv4_address: 172.30.5.10
    restart: always
  other:
    image: ALPINE
    command: sleep infinity
    networks: [back]
    restart: always
  isolated:
    image: ALPINE
    command: sleep infinity
    network_mode: none
    restart: always
networks:
  front:
    labels:
      com.example.net: front
    driver_opts:
      com.docker.network.driver.mtu: "1400"
  back:
    internal: true
    ipam:
      config:
        - subnet: 172.30.5.0/24
`},
	{"volumes", `services:
  app:
    image: ALPINE
    command: sleep infinity
    volumes:
      - data:/data
      - data:/data-ro:ro
      - tuned:/tuned
      - type: volume
        source: data
        target: /nocopy
        volume:
          nocopy: true
      - /var/data
      - type: bind
        source: /tmp
        target: /host-tmp
        read_only: true
        bind:
          # explicit: Compose 2.33, Docker 27's, reads it as false when absent, the specification as true
          create_host_path: true
          propagation: private
          recursive: disabled
      - /srv:/srv-short:ro
      - type: tmpfs
        target: /scratch
        tmpfs:
          size: 1048576
          mode: 1023
    restart: always
volumes:
  data:
    labels:
      com.example.vol: data
  tuned:
    driver_opts:
      type: tmpfs
      device: tmpfs
      o: size=1m
`},
	{"health", `services:
  checked:
    image: ALPINE
    command: sleep infinity
    healthcheck:
      test: ["CMD", "true"]
      interval: 2s
      timeout: 1s
      retries: 2
      start_period: 1s
      start_interval: 1s
    restart: always
  shell-check:
    image: ALPINE
    command: sleep infinity
    healthcheck:
      test: "true"
      interval: 3s
    restart: always
  disabled:
    image: ALPINE
    command: sleep infinity
    healthcheck:
      disable: true
    restart: always
`},
	{"logging", `services:
  app:
    image: ALPINE
    command: sleep infinity
    logging:
      driver: json-file
      options:
        max-size: 1m
        max-file: "2"
    restart: always
  none:
    image: ALPINE
    command: sleep infinity
    logging:
      driver: none
    restart: always
`},
	{"runtime", `services:
  app:
    image: ALPINE
    command: sleep infinity
    container_name: conformance-named
    devices:
      - source: /dev/null
        target: /dev/fake-null
        permissions: rw
    runtime: runc
    userns_mode: host
    cgroup: private
    uts: host
    pid: host
    cpu_period: 100000
    cpu_quota: 50000
    cpuset: "0"
    oom_kill_disable: false
    annotations:
      com.example.note: conformance
    restart: always
  scaled:
    image: ALPINE
    command: sleep infinity
    scale: 2
    links: [app]
    restart: always
`},
}

// untested are the Compose service keys Dockflow supports that no conformance file uses, and why.
// Every other supported key must appear in one: a key declared supported is a promise that the
// container is the one docker compose would create.
var untested = map[string]string{
	"build":          "Dockflow builds with buildx bake, and the images differ by name; the build tests cover it",
	"secrets":        "Dockflow mounts them from a tmpfs of the server, not from the project's directory",
	"configs":        "Dockflow mounts them from a tmpfs of the server, not from the project's directory",
	"env_file":       "read on the machine running dockflow; it ends up in the environment, which is compared",
	"label_file":     "read on the machine running dockflow; it ends up in the labels, which are compared",
	"profiles":       "it selects services, and sets nothing on a container",
	"pull_policy":    "it decides when an image is pulled, and sets nothing on a container",
	"develop":        "ignored: it describes a development loop on the developer's machine",
	"platform":       "the server runs one platform; pulling for another needs a registry",
	"gpus":           "the test server has no GPU",
	"cgroup_parent":  "a parent cgroup depends on the server's cgroup driver",
	"storage_opt":    "it needs a storage driver with quotas, which the test server does not have",
	"mem_swappiness": "cgroup v2 has no swappiness: Docker drops it with a warning",
}

// inspected is what is compared of a container: its configuration, the names of the project's
// networks and volumes made generic.
var inspected = []string{
	"Image",
	"Config.Cmd", "Config.Entrypoint", "Config.Env", "Config.User", "Config.WorkingDir", "Config.Hostname", "Config.Domainname",
	"Config.Labels", "Config.ExposedPorts", "Config.Healthcheck", "Config.StopSignal", "Config.StopTimeout", "Config.Tty", "Config.OpenStdin",
	"HostConfig.Init", "HostConfig.ReadonlyRootfs", "HostConfig.Privileged", "HostConfig.RestartPolicy",
	"HostConfig.Memory", "HostConfig.MemoryReservation", "HostConfig.MemorySwap", "HostConfig.NanoCpus", "HostConfig.CpuShares",
	"HostConfig.PidsLimit", "HostConfig.ShmSize", "HostConfig.OomScoreAdj", "HostConfig.Ulimits",
	"HostConfig.CapAdd", "HostConfig.CapDrop", "HostConfig.SecurityOpt", "HostConfig.GroupAdd", "HostConfig.Sysctls",
	"HostConfig.ExtraHosts", "HostConfig.Dns", "HostConfig.DnsSearch", "HostConfig.DnsOptions", "HostConfig.Tmpfs", "HostConfig.IpcMode",
	"HostConfig.PortBindings", "HostConfig.NetworkMode", "HostConfig.LogConfig",
	"HostConfig.Devices", "HostConfig.Runtime", "HostConfig.UsernsMode", "HostConfig.CgroupnsMode", "HostConfig.UTSMode",
	"HostConfig.PidMode", "HostConfig.CpuPeriod", "HostConfig.CpuQuota", "HostConfig.CpusetCpus", "HostConfig.OomKillDisable",
	"HostConfig.Annotations", "HostConfig.Links",
	// Mounts is what the container got; MountSpecs how it was asked for, HostConfig's Binds and
	// Mounts read as one list; TmpfsMounts the tmpfs mounts the container sees, with their size
	// and mode, in /proc/mounts.
	"Mounts", "MountSpecs", "TmpfsMounts", "Networks",
}

// untestedNested are the nested Compose keys Dockflow handles that no conformance file uses, and
// why; an entry ending in a dot covers every key under it.
var untestedNested = map[string]string{
	"build.":                                "Dockflow builds with buildx bake, and the images differ by name; the build tests cover it",
	"secrets[].":                            "Dockflow mounts secrets from a tmpfs of the server, not from the project's directory",
	"configs[].":                            "Dockflow mounts configs from a tmpfs of the server, not from the project's directory",
	"gpus[].":                               "the test server has no GPU",
	"deploy.resources.reservations.devices": "the test server has no GPU",
	"deploy.resources.reservations.devices[].": "the test server has no GPU",
	"deploy.resources.reservations.cpus":       "ignored with a warning: Docker reserves no CPU outside Swarm",
	"deploy.rollback_config":                   "ignored with a warning: Dockflow rolls back the whole app",
	"deploy.placement":                         "ignored with a warning: there is one server",
	"deploy.endpoint_mode":                     "ignored with a warning: there is one server",
	"deploy.mode":                              "replicated is the default, and global runs one container, with a warning",
	"ports[].":                                 "the long syntax of ports sets what the short one does; name, mode and app_protocol reach no container",
	"volumes[].consistency":                    "Docker ignores it on Linux",
	"volumes[].volume.subpath":                 "the directory must exist in the volume before the container starts",
	"volumes[].bind.selinux":                   "refused: the Engine API cannot relabel a mount",
	"networks.*.ipv6_address":                  "the test server's networks have no IPv6",
	"networks.*.gw_priority":                   "Docker 28 and later: the tests also run on Docker 27",
	"networks.*.interface_name":                "Docker 28.1 and later: the tests also run on Docker 27",
	"networks.*.use_service_name_alias":        "Compose 2.33, Docker 27's, does not know it",
	"networks.*.driver_opts":                   "a bridge endpoint has no option the test could observe",
	"(networks).*.ipam.driver":                 "the test server has only the default IPAM driver",
	"(networks).*.ipam.options":                "the default IPAM driver takes no option",
	"(networks).*.ipam.config[].ip_range":      "covered by the planner's tests of a changed network",
	"(networks).*.ipam.config[].gateway":       "covered by the planner's tests of a changed network",
	"(networks).*.ipam.config[].aux_addresses": "covered by the planner's tests of a changed network",
	"(networks).*.enable_ipv6":                 "the test server's networks have no IPv6",
	"(networks).*.enable_ipv4":                 "Docker 28 and later: the tests also run on Docker 27",
	"(networks).*.driver":                      "the test server has the bridge driver only",
	"(networks).*.attachable":                  "Dockflow's networks are always attachable, for the switch",
	"(networks).*.external":                    "an external network is the server's, which the shared-server tests cover",
	"(networks).*.name":                        "a network's name is the project's in both tools",
	"(volumes).*.driver":                       "the test server has the local driver only, the volume plugin tests cover others",
	"(volumes).*.external":                     "an external volume is the server's, which the shared-server tests cover",
	"ulimits.*.single":                         "the short form, nproc: 512, is a single value the files use as a number",
	"(volumes).*.name":                         "a volume's name is the project's in both tools",
}

// TestConformanceCoversSupportedKeys fails when a Compose key Dockflow supports, at any level,
// is used by no conformance file and has no reason to be untested: a key declared supported is a
// promise that the container is the one docker compose would create.
func TestConformanceCoversSupportedKeys(t *testing.T) {
	paths := map[string]bool{}
	for _, k := range compose.NestedKeys() {
		paths[k[:strings.LastIndex(k, ".")]] = true
	}
	used := map[string]bool{}
	var collect func(path string, v any)
	collect = func(path string, v any) {
		switch v := v.(type) {
		case []any:
			for _, e := range v {
				collect(path+"[]", e)
			}
		case map[string]any:
			if paths[path] {
				for k, e := range v {
					used[path+"."+k] = true
					collect(path+"."+k, e)
				}
			} else if paths[path+".*"] {
				for _, e := range v {
					collect(path+".*", e)
				}
			}
		}
	}
	for _, c := range append(slices.Clone(conformance), startOrder) {
		var doc struct {
			Services map[string]map[string]any `yaml:"services"`
			Networks map[string]any            `yaml:"networks"`
			Volumes  map[string]any            `yaml:"volumes"`
		}
		if err := yaml.Unmarshal([]byte(c.compose), &doc); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		for _, s := range doc.Services {
			for k, v := range s {
				used[k] = true
				collect(k, v)
			}
		}
		for _, n := range doc.Networks {
			collect("(networks).*", n)
		}
		for _, v := range doc.Volumes {
			collect("(volumes).*", v)
		}
	}
	exempt := func(k string, list map[string]string) bool {
		for e := range list {
			if k == e || (strings.HasSuffix(e, ".") && strings.HasPrefix(k, e)) {
				return true
			}
		}
		return false
	}
	check := func(keys []string, list map[string]string) {
		for _, k := range keys {
			switch ex := exempt(k, list); {
			case used[k] && ex && list[k] != "":
				t.Errorf("%s is tested now: remove it from the untested keys", k)
			case !used[k] && !ex:
				t.Errorf("the supported Compose key %s is used by no conformance file: add it to one, or say why it cannot be", k)
			}
		}
	}
	check(compose.SupportedKeys(), untested)
	check(compose.NestedKeys(), untestedNested)
}

// startOrder checks depends_on: each service appends its name to a shared volume when it
// starts, and the order must be the one docker compose follows.
var startOrder = struct{ name, compose string }{"order", `services:
  first:
    image: ALPINE
    command: ["sh", "-c", "echo first >> /order/log; exec sleep infinity"]
    volumes: [order:/order]
    healthcheck:
      test: ["CMD", "true"]
      interval: 1s
      start_period: 5s
      start_interval: 1s
    restart: always
  migrate:
    image: ALPINE
    command: ["sh", "-c", "sleep 1; echo migrate >> /order/log"]
    volumes: [order:/order]
    depends_on:
      first:
        condition: service_healthy
        required: true
    restart: "no"
  last:
    image: ALPINE
    command: ["sh", "-c", "echo last >> /order/log; exec sleep infinity"]
    volumes: [order:/order]
    depends_on:
      migrate:
        condition: service_completed_successfully
    restart: always
volumes:
  order: {}
`}

func TestComposeStartOrder(t *testing.T) {
	compose := strings.ReplaceAll(startOrder.compose, "ALPINE", alpineImage)
	order := func(volume string) string {
		out, err := inServer(fmt.Sprintf("docker run --rm -v %s:/order %s cat /order/log", volume, alpineImage))
		if err != nil {
			t.Fatal(err)
		}
		return strings.Join(strings.Fields(out), " ")
	}
	if _, err := inServer("mkdir -p /conformance/reforder && cat > /conformance/reforder/compose.yml <<'EOF'\n" + compose + "EOF\n" +
		"docker compose -p reforder -f /conformance/reforder/compose.yml up -d --quiet-pull"); err != nil {
		t.Fatalf("docker compose up: %v", err)
	}
	want := order("reforder_order")
	inServer("docker compose -p reforder -f /conformance/reforder/compose.yml down -v")
	if want != "first migrate last" {
		t.Fatalf("docker compose started %q: the fixture is wrong", want)
	}

	dir := filepath.Join(workDir, "conforder")
	writeProject(t, dir, "conforder", compose)
	mustSucceed(t, dockflow(t, dir, "deploy"), "deploy")
	defer dockflow(t, dir, "destroy", "production", "--volumes")
	if got := order("conforder-production_order"); got != want {
		t.Fatalf("Dockflow started %q, docker compose %q", got, want)
	}
}

func TestComposeConformance(t *testing.T) {
	for _, c := range conformance {
		t.Run(c.name, func(t *testing.T) {
			compose := strings.ReplaceAll(c.compose, "ALPINE", alpineImage)
			app := "conf" + strings.ReplaceAll(c.name, "-", "")
			dir := filepath.Join(workDir, app)
			writeProject(t, dir, app, compose)

			// the reference: docker compose up, on the same server
			ref := "ref" + strings.ReplaceAll(c.name, "-", "")
			if _, err := inServer(fmt.Sprintf("mkdir -p /conformance/%[1]s && cat > /conformance/%[1]s/compose.yml <<'EOF'\n%[2]sEOF\n"+
				"docker compose -p %[1]s -f /conformance/%[1]s/compose.yml up -d --quiet-pull", ref, compose)); err != nil {
				t.Fatalf("docker compose up: %v", err)
			}
			want := projectContainers(t, ref)
			wantObjects := projectObjects(t, ref)
			// the ports and the fixed addresses are the server's: the reference gives them back
			if _, err := inServer(fmt.Sprintf("docker compose -p %[1]s -f /conformance/%[1]s/compose.yml down -v", ref)); err != nil {
				t.Fatalf("docker compose down: %v", err)
			}

			mustSucceed(t, dockflow(t, dir, "deploy"), "deploy")
			got := projectContainers(t, app+"-production")
			gotObjects := projectObjects(t, app+"-production")
			for name, w := range wantObjects {
				if g := gotObjects[name]; !reflect.DeepEqual(w, g) {
					wj, _ := json.Marshal(w)
					gj, _ := json.Marshal(g)
					t.Errorf("%s differs\n  docker compose: %s\n  dockflow:       %s", name, wj, gj)
				}
			}
			defer dockflow(t, dir, "destroy", "production", "--volumes")

			for service, w := range want {
				g, ok := got[service]
				if !ok {
					t.Errorf("%s: Dockflow runs no container of it", service)
					continue
				}
				for _, field := range inspected {
					if !reflect.DeepEqual(w[field], g[field]) {
						wj, _ := json.Marshal(w[field])
						gj, _ := json.Marshal(g[field])
						t.Errorf("%s: %s differs\n  docker compose: %s\n  dockflow:       %s", service, field, wj, gj)
					}
				}
			}
		})
	}
}

// projectObjects returns the compared settings of a project's networks and volumes, by
// "network <key>" and "volume <key>".
func projectObjects(t *testing.T, project string) map[string]any {
	t.Helper()
	out := map[string]any{}
	for _, kind := range []string{"network", "volume"} {
		names, err := inServer(fmt.Sprintf("docker %s ls -q --filter label=com.docker.compose.project=%s", kind, project))
		if err != nil {
			t.Fatal(err)
		}
		if names == "" {
			continue
		}
		raw, err := inServer(fmt.Sprintf("docker %s inspect %s", kind, strings.Join(strings.Fields(names), " ")))
		if err != nil {
			t.Fatal(err)
		}
		var all []map[string]any
		json.Unmarshal([]byte(raw), &all)
		for _, o := range all {
			labels := map[string]any{}
			key := ""
			if m, ok := o["Labels"].(map[string]any); ok {
				for k, v := range m {
					switch {
					case k == "com.docker.compose."+kind:
						key = fmt.Sprint(v)
					case !strings.HasPrefix(k, "com.docker.compose.") && !strings.HasPrefix(k, "dockflow."):
						labels[k] = v
					}
				}
			}
			fields := map[string]any{"Driver": o["Driver"], "Options": o["Options"], "Labels": labels}
			if kind == "network" {
				fields["Internal"], fields["EnableIPv6"] = o["Internal"], o["EnableIPv6"]
				fields["IPAM"] = at(o, "IPAM.Config")
			}
			out[kind+" "+key] = fields
		}
	}
	return out
}

// projectContainers returns the compared fields of the first container of each service of a
// Compose project, by service.
func projectContainers(t *testing.T, project string) map[string]map[string]any {
	t.Helper()
	ids, err := inServer("docker ps -aq --filter label=com.docker.compose.project=" + project)
	if err != nil || ids == "" {
		t.Fatalf("the containers of %s: %v %s", project, err, ids)
	}
	out, err := inServer("docker inspect " + strings.Join(strings.Fields(ids), " "))
	if err != nil {
		t.Fatal(err)
	}
	var all []map[string]any
	if err := json.Unmarshal([]byte(out), &all); err != nil {
		t.Fatal(err)
	}
	byService := map[string]map[string]any{}
	for _, c := range all {
		labels, _ := at(c, "Config.Labels").(map[string]any)
		service, _ := labels["com.docker.compose.service"].(string)
		number, _ := labels["com.docker.compose.container-number"].(string)
		if service == "" || (number != "" && number != "1") {
			continue
		}
		byService[service] = normalize(c, project)
		mounts, err := inServer("docker exec " + fmt.Sprint(c["Id"]) + " cat /proc/mounts")
		if err != nil {
			mounts = "not running"
		}
		var tmpfs []string
		for _, line := range strings.Split(mounts, "\n") {
			if f := strings.Fields(line); len(f) >= 4 && f[2] == "tmpfs" {
				tmpfs = append(tmpfs, strings.Join(f[1:4], " "))
			}
		}
		sort.Strings(tmpfs)
		byService[service]["TmpfsMounts"] = tmpfs
	}
	return byService
}

func at(v any, path string) any {
	for _, k := range strings.Split(path, ".") {
		m, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		v = m[k]
	}
	return v
}

// normalize keeps the compared fields of a container, with what necessarily differs between two
// projects made generic: the project's name in its networks and volumes, the container's name
// and ID, and the labels each tool adds for itself.
func normalize(c map[string]any, project string) map[string]any {
	id, _ := c["Id"].(string)
	name := strings.TrimPrefix(fmt.Sprint(c["Name"]), "/")
	generic := func(s string) string {
		s = strings.ReplaceAll(s, project+"_", "PROJECT_")
		if len(id) >= 12 {
			s = strings.ReplaceAll(s, id[:12], "ID")
		}
		return s
	}
	out := map[string]any{}
	for _, f := range inspected {
		switch f {
		case "Networks", "TmpfsMounts":
			continue
		case "MountSpecs":
			out[f] = mountSpecs(c, generic)
			continue
		case "Mounts":
			var ms []string
			if list, ok := c["Mounts"].([]any); ok {
				for _, m := range list {
					m := m.(map[string]any)
					src := fmt.Sprint(m["Name"])
					if m["Type"] == "bind" {
						src = fmt.Sprint(m["Source"])
					} else if anon.MatchString(src) {
						src = "ANONYMOUS"
					}
					ms = append(ms, generic(fmt.Sprintf("%v %s:%v rw=%v", m["Type"], src, m["Destination"], m["RW"])))
				}
			}
			sort.Strings(ms)
			out[f] = ms
			continue
		}
		v := at(c, f)
		switch f {
		case "Config.Env":
			v = sorted(v)
		case "Config.Labels":
			// Compose's labels that docker compose ps and friends read are compared; the ones
			// that describe each tool's run are not
			labels := map[string]any{}
			if m, ok := v.(map[string]any); ok {
				for k, val := range m {
					switch k {
					case "com.docker.compose.service", "com.docker.compose.oneoff", "com.docker.compose.container-number":
						labels[k] = val
					case "com.docker.compose.project":
						labels[k] = "PROJECT"
					default:
						if !strings.HasPrefix(k, "com.docker.compose.") && !strings.HasPrefix(k, "dockflow.") {
							labels[k] = val
						}
					}
				}
			}
			v = labels
		case "Config.Hostname":
			if s, _ := v.(string); len(id) >= 12 && s == id[:12] {
				v = "ID"
			}
		case "HostConfig.NetworkMode":
			v = generic(fmt.Sprint(v))
		case "HostConfig.Ulimits":
			if l, ok := v.([]any); ok {
				sort.Slice(l, func(i, j int) bool {
					return fmt.Sprint(l[i].(map[string]any)["Name"]) < fmt.Sprint(l[j].(map[string]any)["Name"])
				})
			}
		case "HostConfig.CapAdd", "HostConfig.CapDrop":
			// Docker 27 keeps capabilities as given: CAP_NET_ADMIN and NET_ADMIN are one
			var caps []string
			for _, c := range asStrings(v) {
				caps = append(caps, strings.TrimPrefix(c, "CAP_"))
			}
			v = sorted(toAny(caps))
		case "Config.ExposedPorts":
			v = exposedPorts(v)
		case "HostConfig.SecurityOpt", "HostConfig.GroupAdd", "HostConfig.ExtraHosts":
			// lists whose order means nothing; the resolver's servers and search domains are
			// tried in order, so dns and dns_search are compared as they are
			v = sorted(v)
		}
		if m, ok := v.(map[string]any); ok && len(m) == 0 {
			// an empty map is no map, as Docker reports either
			v = nil
		}
		out[f] = v
	}
	var nets []string
	if m, ok := at(c, "NetworkSettings.Networks").(map[string]any); ok {
		for net, cfg := range m {
			cfg := cfg.(map[string]any)
			var aliases []string
			for _, a := range asStrings(cfg["Aliases"]) {
				if a != name && (len(id) < 12 || a != id[:12]) {
					aliases = append(aliases, a)
				}
			}
			sort.Strings(aliases)
			ipam, _ := cfg["IPAMConfig"].(map[string]any)
			// a MAC address Docker chose is random; the conformance files set theirs in de:ad:
			mac := ""
			if s := fmt.Sprint(cfg["MacAddress"]); strings.HasPrefix(s, "de:ad:") {
				mac = s
			}
			nets = append(nets, generic(fmt.Sprintf("%s aliases=%v ip=%v ip6=%v link-local=%v mac=%s driver-opts=%v gw-priority=%v",
				net, aliases, ipam["IPv4Address"], ipam["IPv6Address"], ipam["LinkLocalIPs"], mac, cfg["DriverOpts"], cfg["GwPriority"])))
		}
	}
	sort.Strings(nets)
	out["Networks"] = nets
	return out
}

// mountSpecs reads how a container's mounts were asked for, by target: Docker's short form
// (HostConfig.Binds, src:dst:options) and its long one (HostConfig.Mounts) say the same things
// differently, and Compose and Dockflow need not use the same one.
func mountSpecs(c map[string]any, generic func(string) string) []string {
	var out []string
	add := func(typ, src, target string, ro bool, propagation string, create, nocopy bool, subpath, recursive string, size, mode any) {
		if typ == "bind" && propagation == "" {
			propagation = "rprivate"
		}
		if typ == "volume" && (src == "" || anon.MatchString(src)) {
			src = "ANONYMOUS"
		}
		if typ != "bind" {
			create = false
		}
		out = append(out, generic(fmt.Sprintf("%s %s:%s ro=%v propagation=%s create=%v nocopy=%v subpath=%s recursive=%s tmpfs=%v/%v",
			typ, src, target, ro, propagation, create, nocopy, subpath, recursive, size, mode)))
	}
	for _, b := range asStrings(at(c, "HostConfig.Binds")) {
		parts := strings.Split(b, ":")
		if len(parts) < 2 {
			continue
		}
		typ := "volume"
		if strings.HasPrefix(parts[0], "/") {
			typ = "bind"
		}
		ro, nocopy, propagation := false, false, ""
		if len(parts) > 2 {
			for _, o := range strings.Split(parts[2], ",") {
				switch o {
				case "ro":
					ro = true
				case "nocopy":
					nocopy = true
				case "private", "rprivate", "shared", "rshared", "slave", "rslave":
					propagation = o
				}
			}
		}
		// the short form creates a missing source directory
		add(typ, parts[0], parts[1], ro, propagation, true, nocopy, "", "", nil, nil)
	}
	if list, ok := at(c, "HostConfig.Mounts").([]any); ok {
		for _, m := range list {
			m := m.(map[string]any)
			ro, _ := m["ReadOnly"].(bool)
			propagation, _ := at(m, "BindOptions.Propagation").(string)
			create, _ := at(m, "BindOptions.CreateMountpoint").(bool)
			nocopy, _ := at(m, "VolumeOptions.NoCopy").(bool)
			subpath, _ := at(m, "VolumeOptions.Subpath").(string)
			recursive := ""
			switch {
			case at(m, "BindOptions.NonRecursive") == true:
				recursive = "disabled"
			case at(m, "BindOptions.ReadOnlyNonRecursive") == true:
				recursive = "writable"
			case at(m, "BindOptions.ReadOnlyForceRecursive") == true:
				recursive = "readonly"
			}
			add(fmt.Sprint(m["Type"]), fmt.Sprint(m["Source"]), fmt.Sprint(m["Target"]), ro, propagation, create, nocopy, subpath, recursive,
				at(m, "TmpfsOptions.SizeBytes"), at(m, "TmpfsOptions.Mode"))
		}
	}
	sort.Strings(out)
	return out
}

// exposedPorts are the exposed ports as a set of port/protocol: Docker 27 keeps what it was given
// (8080, 9000-9001/udp), where later versions expand ranges and add the protocol.
func exposedPorts(v any) any {
	m, ok := v.(map[string]any)
	if !ok || len(m) == 0 {
		return nil
	}
	set := map[string]any{}
	for k := range m {
		port, proto, _ := strings.Cut(k, "/")
		if proto == "" {
			proto = "tcp"
		}
		first, last, isRange := strings.Cut(port, "-")
		lo, _ := strconv.Atoi(first)
		hi := lo
		if isRange {
			hi, _ = strconv.Atoi(last)
		}
		for p := lo; p <= hi; p++ {
			set[fmt.Sprintf("%d/%s", p, proto)] = map[string]any{}
		}
	}
	return set
}

func toAny(s []string) []any {
	out := make([]any, len(s))
	for i, v := range s {
		out[i] = v
	}
	return out
}

var anon = regexp.MustCompile(`^[0-9a-f]{64}$`)

func asStrings(v any) []string {
	var out []string
	if l, ok := v.([]any); ok {
		for _, s := range l {
			out = append(out, fmt.Sprint(s))
		}
	}
	return out
}

// sorted sorts a list of strings; an empty list is no list, as Docker reports either.
func sorted(v any) any {
	s := asStrings(v)
	if len(s) == 0 {
		return nil
	}
	slices.Sort(s)
	return s
}

// TestChangedNetworkOrVolumeIsRefused: Docker applies a network's or a volume's settings when it
// creates it, as docker compose does, so a deploy that would leave the old ones in place is refused.
func TestChangedNetworkOrVolumeIsRefused(t *testing.T) {
	app := "confdrift"
	dir := filepath.Join(workDir, app)
	compose := func(subnet, size string) string {
		return fmt.Sprintf(`services:
  app:
    image: %s
    command: sleep infinity
    networks: [back]
    volumes: [cache:/cache]
networks:
  back:
    ipam:
      config:
        - subnet: %s
volumes:
  cache:
    driver_opts: {type: tmpfs, device: tmpfs, o: "size=%s"}
`, alpineImage, subnet, size)
	}
	writeProject(t, dir, app, compose("172.31.7.0/24", "1m"))
	mustSucceed(t, dockflow(t, dir, "deploy"), "first deploy")
	defer dockflow(t, dir, "destroy", "production", "--volumes")
	mustSucceed(t, dockflow(t, dir, "deploy"), "the same deploy again")

	writeProject(t, dir, app, compose("172.31.8.0/24", "1m"))
	if r := dockflow(t, dir, "deploy"); r.code == 0 || !strings.Contains(r.out, "plan.network_changed") {
		t.Fatalf("a changed subnet: exit %d\n%s", r.code, r.out)
	}
	writeProject(t, dir, app, compose("172.31.7.0/24", "2m"))
	if r := dockflow(t, dir, "deploy"); r.code == 0 || !strings.Contains(r.out, "plan.volume_changed") {
		t.Fatalf("changed volume options: exit %d\n%s", r.code, r.out)
	}
	// a removal: the ipam block of the current release, gone from the file
	noIPAM := strings.Replace(compose("172.31.7.0/24", "1m"), "    ipam:\n      config:\n        - subnet: 172.31.7.0/24\n", "    labels: {}\n", 1)
	writeProject(t, dir, app, noIPAM)
	if r := dockflow(t, dir, "deploy"); r.code == 0 || !strings.Contains(r.out, "ipam.config was removed") {
		t.Fatalf("a removed ipam block: exit %d\n%s", r.code, r.out)
	}
}
