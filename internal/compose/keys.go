package compose

import (
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strings"

	"github.com/compose-spec/compose-go/v2/types"

	"github.com/Shawiizz/dockflow/internal/errs"
)

// nested are the keys Dockflow handles inside the values of Compose keys, by path: the entries
// of a map whose keys are names (a service's networks) are path.*, the elements of a list
// path[]. A key outside its path's list is refused, as at the top level, so nothing Compose adds
// is ignored without a word. Paths absent from the table hold data, such as environment or
// labels, and are not walked. Keys refused or warned about with their own message elsewhere are
// listed, so that message is the one shown.
var nested = map[string][]string{
	"ports[]":          {"name", "mode", "host_ip", "target", "published", "protocol", "app_protocol"},
	"volumes[]":        {"type", "source", "target", "read_only", "consistency", "bind", "volume", "tmpfs"},
	"volumes[].bind":   {"propagation", "create_host_path", "selinux", "recursive"},
	"volumes[].volume": {"nocopy", "subpath"},
	"volumes[].tmpfs":  {"size", "mode"},
	"networks.*": {"aliases", "ipv4_address", "ipv6_address", "mac_address", "link_local_ips", "driver_opts",
		"priority", "gw_priority", "interface_name", "use_service_name_alias"},
	"deploy": {"mode", "replicas", "update_config", "rollback_config", "resources", "restart_policy",
		"placement", "endpoint_mode"},
	"deploy.update_config":                    {"order"},
	"deploy.resources":                        {"limits", "reservations"},
	"deploy.resources.limits":                 {"cpus", "memory", "pids"},
	"deploy.resources.reservations":           {"cpus", "memory", "devices"},
	"deploy.resources.reservations.devices[]": {"capabilities", "driver", "count", "device_ids", "options"},
	"deploy.restart_policy":                   {"condition", "max_attempts"},
	"depends_on.*":                            {"condition", "required"},
	"secrets[]":                               {"source", "target", "uid", "gid", "mode"},
	"configs[]":                               {"source", "target", "uid", "gid", "mode"},
	"ulimits.*":                               {"single", "soft", "hard"},
	"devices[]":                               {"source", "target", "permissions"},
	"gpus[]":                                  {"capabilities", "driver", "count", "device_ids", "options"},
	"healthcheck":                             {"test", "timeout", "interval", "retries", "start_period", "start_interval", "disable"},
	"logging":                                 {"driver", "options"},
	"build": {"context", "dockerfile", "dockerfile_inline", "entitlements", "args", "provenance", "sbom", "ssh",
		"labels", "cache_from", "cache_to", "no_cache", "no_cache_filter", "additional_contexts", "pull",
		"extra_hosts", "isolation", "network", "target", "secrets", "shm_size", "tags", "ulimits", "platforms", "privileged"},
	"build.ssh[]":     {"id", "path"},
	"build.secrets[]": {"source", "target"},

	// the project's own networks and volumes
	"(networks).*": {"name", "driver", "driver_opts", "ipam", "external", "internal", "attachable", "labels",
		"enable_ipv4", "enable_ipv6"},
	"(networks).*.ipam":          {"driver", "config", "options"},
	"(networks).*.ipam.config[]": {"subnet", "gateway", "ip_range", "aux_addresses"},
	"(volumes).*":                {"name", "driver", "driver_opts", "external", "labels"},
}

// ignoredNested are keys Dockflow ignores with a warning, as docker compose ignores them too.
var ignoredNested = map[string]string{
	"depends_on.*.restart":                   "Dockflow does not restart a service when one it depends on is replaced",
	"deploy.labels":                          "they label Swarm services; docker compose ignores them too",
	"deploy.update_config.parallelism":       "it belongs to Swarm's rolling update; x-dockflow.rollout sets Dockflow's",
	"deploy.update_config.delay":             "it belongs to Swarm's rolling update; x-dockflow.rollout sets Dockflow's",
	"deploy.update_config.failure_action":    "it belongs to Swarm's rolling update; Dockflow rolls back a failed deploy",
	"deploy.update_config.monitor":           "it belongs to Swarm's rolling update; x-dockflow.health sets how long Dockflow watches",
	"deploy.update_config.max_failure_ratio": "it belongs to Swarm's rolling update; a failed container fails the deploy",
	"deploy.restart_policy.delay":            "Docker's restart policies have no delay; docker compose ignores it too",
	"deploy.restart_policy.window":           "Docker's restart policies have no window; docker compose ignores it too",
	"build.secrets[].uid":                    "BuildKit takes a build secret's owner from the Dockerfile's RUN --mount",
	"build.secrets[].gid":                    "BuildKit takes a build secret's owner from the Dockerfile's RUN --mount",
	"build.secrets[].mode":                   "BuildKit takes a build secret's mode from the Dockerfile's RUN --mount",
}

// NestedKeys returns the paths of the keys Dockflow handles inside the values of Compose keys,
// sorted: volumes[].tmpfs.mode, networks.*.priority.
func NestedKeys() []string {
	var out []string
	for path, keys := range nested {
		for _, k := range keys {
			out = append(out, path+"."+k)
		}
	}
	sort.Strings(out)
	return out
}

// walk checks the keys of v, the value at path, against nested: it refuses an unknown key and
// warns about an ignored one, then walks the values whose paths are in the table.
func walk(at, path string, v any, warnings *[]string) error {
	switch v := v.(type) {
	case []any:
		for _, e := range v {
			if err := walk(at, path+"[]", e, warnings); err != nil {
				return err
			}
		}
	case map[string]any:
		keys, known := nested[path]
		if !known {
			// a map of names: its entries are path.*
			if _, ok := nested[path+".*"]; ok {
				for _, name := range sortedKeys(v) {
					if err := walk(at, path+".*", v[name], warnings); err != nil {
						return err
					}
				}
			}
			return nil
		}
		for _, k := range sortedKeys(v) {
			if zero(v[k]) {
				continue
			}
			key := path + "." + k
			switch {
			case slices.Contains(keys, k):
				if err := walk(at, key, v[k], warnings); err != nil {
					return err
				}
			case ignoredNested[key] != "":
				*warnings = append(*warnings, fmt.Sprintf("%s: %s is ignored: %s", at, shown(key), ignoredNested[key]))
			default:
				return errs.Config("%s: the Compose key `%s` is not supported yet", at, shown(key)).
					WithHint("supported keys are listed in docs/design/spec/config-v1.md#compose-support")
			}
		}
	}
	return nil
}

// shown is a path as the user wrote it: volumes.tmpfs.mode, without the markers of lists and maps.
func shown(path string) string {
	path = strings.TrimPrefix(strings.TrimPrefix(path, "(networks)"), "(volumes)")
	path = strings.ReplaceAll(strings.ReplaceAll(path, "[]", ""), ".*", ".<name>")
	return strings.TrimPrefix(path, ".")
}

// zero tells whether a JSON value is the zero value of its type: an unset key.
func zero(v any) bool {
	switch v := v.(type) {
	case nil:
		return true
	case string:
		return v == ""
	case bool:
		return !v
	case float64:
		return v == 0
	case []any:
		return len(v) == 0
	case map[string]any:
		return len(v) == 0
	}
	return false
}

func asJSON(v any) (map[string]any, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, errs.Internal("encode the Compose file").WithCause(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, errs.Internal("decode the Compose file").WithCause(err)
	}
	return m, nil
}

// checkKeys refuses the keys of a service Dockflow does not support, at every level, and returns
// warnings for those it ignores as docker compose does.
func checkKeys(s types.ServiceConfig) ([]string, error) {
	m, err := asJSON(s)
	if err != nil {
		return nil, err
	}
	at := "service " + s.Name
	var warnings []string
	for _, k := range sortedKeys(m) {
		if zero(m[k]) {
			continue
		}
		if ms, ok := later[k]; ok {
			return nil, errs.Config("%s: `%s` is not available yet in this version of Dockflow", at, k).
				WithHint("it arrives with milestone %s (docs/design/roadmap.md)", ms)
		}
		if !supported[k] {
			return nil, errs.Config("%s: the Compose key `%s` is not supported yet", at, k).
				WithHint("supported keys are listed in docs/design/spec/config-v1.md#compose-support")
		}
		if err := walk(at, k, m[k], &warnings); err != nil {
			return nil, err
		}
	}
	return warnings, nil
}

// checkProjectKeys checks the keys of the project's networks and volumes as checkKeys does a
// service's.
func checkProjectKeys(p *types.Project) ([]string, error) {
	var warnings []string
	for kind, defs := range map[string]any{"networks": p.Networks, "volumes": p.Volumes} {
		m, err := asJSON(defs)
		if err != nil {
			return nil, err
		}
		for _, name := range sortedKeys(m) {
			if err := walk(kind+"."+name, "("+kind+").*", m[name], &warnings); err != nil {
				return nil, err
			}
		}
	}
	sort.Strings(warnings)
	return warnings, nil
}
