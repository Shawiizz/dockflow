package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path"
	"strconv"

	"github.com/compose-spec/compose-go/v2/types"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/errs"
)

// mountFiles mounts the secrets and configs a service references (ADR-0012): each becomes a
// file named after its content and permissions, bind-mounted read-only. It records the files in
// r, and their contents in r.Contents.
func mountFiles(p *types.Project, stack string, s types.ServiceConfig, spec *domain.ContainerSpec, r *Result) error {
	at := "service " + s.Name
	for _, ref := range s.Secrets {
		def, ok := p.Secrets[ref.Source]
		if !ok {
			return errs.Config("%s: secret %q is not declared under secrets", at, ref.Source)
		}
		target := ref.Target
		switch {
		case target == "":
			target = "/run/secrets/" + ref.Source
		case !path.IsAbs(target):
			target = "/run/secrets/" + target
		}
		if err := mountFile(at, stack, ref.Source, types.FileObjectConfig(def), types.FileReferenceConfig(ref), target, true, spec, r); err != nil {
			return err
		}
	}
	for _, ref := range s.Configs {
		def, ok := p.Configs[ref.Source]
		if !ok {
			return errs.Config("%s: config %q is not declared under configs", at, ref.Source)
		}
		target := ref.Target
		if target == "" {
			target = "/" + ref.Source
		}
		if err := mountFile(at, stack, ref.Source, types.FileObjectConfig(def), types.FileReferenceConfig(ref), target, false, spec, r); err != nil {
			return err
		}
	}
	return nil
}

func mountFile(at, stack, name string, def types.FileObjectConfig, ref types.FileReferenceConfig, target string, secret bool,
	spec *domain.ContainerSpec, r *Result) error {
	kind := "config"
	if secret {
		kind = "secret"
	}
	if def.External {
		return errs.Config("%s: the %s %s is external: external %ss belong to Swarm", at, kind, name, kind).
			WithHint("give it a file, environment or content source")
	}
	if def.Driver != "" || def.TemplateDriver != "" {
		return errs.Config("%s: the %s %s has a driver: drivers belong to Swarm", at, kind, name)
	}
	content := def.Content
	switch {
	case def.File != "":
		b, err := os.ReadFile(def.File)
		if err != nil {
			return errs.Config("%s: the %s %s: %v", at, kind, name, err)
		}
		content = string(b)
	case def.Environment != "":
		// compose-go fills Content from the project's variables; an unset one is an error
		if def.Content == "" {
			return errs.Config("%s: the %s %s reads %s, which is not set", at, kind, name, def.Environment).
				WithHint("define it as a secret or under environments.<env>.vars")
		}
	case !secret && def.Content != "":
	default:
		return errs.Config("%s: the %s %s needs a file, environment or content source", at, kind, name)
	}
	f := domain.File{Name: name, Secret: secret, Mode: 0o444}
	var err error
	if f.UID, err = id(ref.UID); err != nil {
		return errs.Config("%s: %s %s: uid %q is not a number", at, kind, name, ref.UID)
	}
	if f.GID, err = id(ref.GID); err != nil {
		return errs.Config("%s: %s %s: gid %q is not a number", at, kind, name, ref.GID)
	}
	if ref.Mode != nil {
		f.Mode = uint32(*ref.Mode)
	}
	sum := sha256.Sum256(fmt.Appendf(nil, "%d:%d:%o:%s", f.UID, f.GID, f.Mode, content))
	f.Hash = hex.EncodeToString(sum[:])
	if secret {
		f.Path = domain.SecretPath(stack, name, f.Hash)
		r.Secrets = append(r.Secrets, content)
	} else {
		f.Path = domain.ConfigPath(stack, name, f.Hash)
	}
	if r.Contents == nil {
		r.Contents = map[string]string{}
	}
	if _, seen := r.Contents[f.Path]; !seen {
		r.Contents[f.Path] = content
		r.App.Files = append(r.App.Files, f)
	}
	spec.Mounts = append(spec.Mounts, domain.Mount{Type: "bind", Source: f.Path, Target: target, ReadOnly: true})
	return nil
}

func id(s string) (int, error) {
	if s == "" {
		return 0, nil
	}
	return strconv.Atoi(s)
}
