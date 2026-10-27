package compose

import (
	"slices"
	"strings"

	"github.com/compose-spec/compose-go/v2/types"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
)

// backupOf checks x-dockflow.backup and converts it (ADR-0015).
func backupOf(at string, x *BackupExt, svc *domain.Service, s types.ServiceConfig) (*domain.Backup, error) {
	at += ": x-dockflow.backup"
	if !svc.Stateful {
		return nil, errs.Config("%s: only a stateful service is backed up", at).
			WithHint("set x-dockflow.stateful: true on the service that holds the data")
	}
	b := &domain.Backup{
		Type: x.Type, Database: x.Database, Dump: x.Dump, Restore: x.Restore, Keep: x.Keep,
		DumpOptions: strings.Fields(x.DumpOptions), RestoreOptions: strings.Fields(x.RestoreOptions),
		Quiesce: domain.Quiesce{Mode: x.Quiesce.Mode, Pre: x.Quiesce.Pre, Post: x.Quiesce.Post},
	}
	dump := x.Type == domain.BackupPostgres || x.Type == domain.BackupMySQL || x.Type == domain.BackupMongo || x.Type == domain.BackupRedis
	switch {
	case dump:
		if len(x.Volumes) > 0 || x.Quiesce.Mode != "" || len(x.Dump) > 0 || len(x.Restore) > 0 {
			return nil, errs.Config("%s: type %s takes database, dump_options, restore_options and keep; volumes, quiesce, dump and restore go with the volume and command types", at, x.Type)
		}
	case x.Type == domain.BackupVolume:
		if x.Database != "" || x.DumpOptions != "" || x.RestoreOptions != "" || len(x.Dump) > 0 || len(x.Restore) > 0 {
			return nil, errs.Config("%s: type volume takes volumes, quiesce and keep", at)
		}
		targets, err := backupTargets(at, x.Volumes, s)
		if err != nil {
			return nil, err
		}
		b.Volumes = targets
		switch x.Quiesce.Mode {
		case "":
			b.Quiesce.Mode = domain.QuiesceStop
		case domain.QuiesceStop, domain.QuiesceNone:
		case domain.QuiesceExec:
			if len(x.Quiesce.Pre) == 0 && len(x.Quiesce.Post) == 0 {
				return nil, errs.Config("%s: quiesce.exec needs pre or post commands", at)
			}
		default:
			return nil, errs.Config("%s: quiesce %q is stop, none, or { exec: { pre, post } }", at, x.Quiesce.Mode)
		}
	case x.Type == domain.BackupCommand:
		if len(x.Dump) == 0 || len(x.Restore) == 0 {
			return nil, errs.Config("%s: type command needs dump and restore, as argument lists: its stdout is the backup, its stdin the restore", at)
		}
		if x.Database != "" || x.DumpOptions != "" || x.RestoreOptions != "" || len(x.Volumes) > 0 || x.Quiesce.Mode != "" {
			return nil, errs.Config("%s: type command takes dump, restore and keep", at)
		}
	case x.Type == "":
		return nil, errs.Config("%s: type is required: postgres, mysql, mongo, redis, volume or command", at)
	default:
		return nil, errs.Config("%s: type %q is postgres, mysql, mongo, redis, volume or command", at, x.Type)
	}
	if k := x.Keep; k != nil && (k.Last < 0 || k.Hourly < 0 || k.Daily < 0 || k.Weekly < 0 || k.Monthly < 0) {
		return nil, errs.Config("%s: keep counts cannot be negative", at)
	}
	return b, nil
}

// backupTargets are the container paths of the mounts a volume backup copies: those named, by
// volume key or bind source, or every volume and bind mount of the service.
func backupTargets(at string, names []string, s types.ServiceConfig) ([]string, error) {
	var all []string
	byName := map[string]string{}
	for _, v := range s.Volumes {
		if v.Type != types.VolumeTypeVolume && v.Type != types.VolumeTypeBind {
			continue
		}
		if v.Source == "" {
			// an anonymous volume holds nothing to keep
			continue
		}
		all = append(all, v.Target)
		byName[v.Source] = v.Target
	}
	if len(names) == 0 {
		if len(all) == 0 {
			return nil, errs.Config("%s: the service mounts no volume to back up", at)
		}
		return all, nil
	}
	var out []string
	for _, n := range names {
		t, ok := byName[n]
		if !ok {
			return nil, errs.Config("%s: %s is not a volume or bind mount of the service", at, n).
				WithHint("name a volume by its key in the Compose file, or a bind mount by its path on the server")
		}
		if !slices.Contains(out, t) {
			out = append(out, t)
		}
	}
	return out, nil
}
