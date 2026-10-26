package agent

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/state"
	"github.com/Shawiizz/dockflow/internal/upload"
)

// HelperRequest is what the upload helper container does: apply a manifest to a target.
type HelperRequest struct {
	Target   string `json:"target"`
	Manifest string `json:"manifest"` // path of the manifest file
	Blobs    string `json:"blobs"`
	Mirror   bool   `json:"mirror"`
	Mode     uint32 `json:"mode"`
	UID      int    `json:"uid"`
	GID      int    `json:"gid"`
	// Manifests is where the helper writes the manifest that restores the target; it prints its
	// digest as its last line.
	Manifests string `json:"manifests"`
}

// HelperEnv is the environment variable that carries a HelperRequest.
const HelperEnv = "DOCKFLOW_UPLOAD"

func uploadDirs(app *state.App) (blobs, manifests string) {
	return filepath.Join(app.Dir(), "uploads", "blobs"), filepath.Join(app.Dir(), "uploads", "manifests")
}

// haveBlobs answers which of the request's blobs the server lacks.
func (r *runner) haveBlobs() events.RunFinishedData {
	blobs, _ := uploadDirs(r.app)
	missing := []string{}
	for _, sum := range r.req.Have {
		if !upload.Store(blobs).Has(sum) {
			missing = append(missing, sum)
		}
	}
	r.result(map[string]any{"missing": missing})
	return events.RunFinishedData{Outcome: events.OutcomeSuccess}
}

// receive stores the manifests of the request and the blobs that follow it on stdin, each
// checked against its hash.
func (r *runner) receive() error {
	blobs, manifests := uploadDirs(r.app)
	for _, dir := range []string{blobs, manifests} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return errs.Internal("create %s: %v", dir, err)
		}
	}
	for digest, m := range r.req.Manifests {
		if m.Digest() != digest {
			return errs.Internal("the manifest %s does not match its digest", digest)
		}
		if err := writeManifest(manifests, &m); err != nil {
			return err
		}
	}
	if r.req.Blobs == 0 {
		return nil
	}
	if r.Payload == nil {
		return errs.Internal("the request announces %d files but brings none", r.req.Blobs)
	}
	tr := tar.NewReader(r.Payload)
	n := 0
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return errs.Internal("read the uploaded files: %v", err)
		}
		sum := path.Base(hdr.Name)
		tmp, err := os.CreateTemp(blobs, ".incoming-")
		if err != nil {
			return errs.Internal("store an uploaded file: %v", err)
		}
		h := sha256.New()
		if _, err := io.Copy(io.MultiWriter(tmp, h), tr); err != nil {
			tmp.Close()
			os.Remove(tmp.Name())
			return errs.Internal("receive an uploaded file: %v", err)
		}
		tmp.Close()
		if hex.EncodeToString(h.Sum(nil)) != sum {
			os.Remove(tmp.Name())
			return errs.Internal("an uploaded file does not match its hash %s", sum)
		}
		if err := os.Rename(tmp.Name(), filepath.Join(blobs, sum)); err != nil {
			return errs.Internal("store an uploaded file: %v", err)
		}
		n++
	}
	r.ev.Debug(events.Log, fmt.Sprintf("%d files received", n), map[string]any{"line": "received " + strconv.Itoa(n)})
	return nil
}

func writeManifest(dir string, m *upload.Manifest) error {
	b, _ := json.Marshal(m)
	p := filepath.Join(dir, strings.TrimPrefix(m.Digest(), "sha256:")+".json")
	if err := os.WriteFile(p+".tmp", b, 0o600); err != nil {
		return errs.Internal("write a manifest: %v", err)
	}
	return os.Rename(p+".tmp", p)
}

func manifestPath(app *state.App, digest string) string {
	_, manifests := uploadDirs(app)
	return filepath.Join(manifests, strings.TrimPrefix(digest, "sha256:")+".json")
}

// appliedUpload is an upload a run applied, with the manifest that restores its destination.
type appliedUpload struct {
	upload   domain.Upload
	baseline string
}

// applyUpload makes the destination of u match its manifest, through a helper container from
// the agent's own image, which mounts the destination (ADR-0021). It returns the digest of the
// manifest that restores the destination.
func (r *runner) applyUpload(ctx context.Context, u domain.Upload, manifest string, mirror bool) (string, upload.Stats, error) {
	if r.req.AgentImage == "" {
		return "", upload.Stats{}, errs.Internal("the agent does not know its own image")
	}
	blobs, manifests := uploadDirs(r.app)
	hr := HelperRequest{
		Manifest: manifestPath(r.app, manifest), Blobs: blobs, Mirror: mirror, Manifests: manifests, UID: -1, GID: -1,
	}
	if u.Mode != "" {
		m, _ := strconv.ParseUint(u.Mode, 8, 32)
		hr.Mode = uint32(m)
	}
	var err error
	if hr.UID, hr.GID, err = upload.ParseOwner(u.Owner); err != nil {
		return "", upload.Stats{}, errs.Config("%s", err.Error())
	}
	mounts := []domain.Mount{{Type: "bind", Source: state.Root, Target: state.Root}}
	if u.Volume != "" {
		mounts = append(mounts, domain.Mount{Type: "volume", Source: u.Volume, Target: "/dest"})
		hr.Target = "/dest"
	} else {
		mounts = append(mounts, domain.Mount{Type: "bind", Source: filepath.Dir(u.Dest), Target: "/dest-parent", CreateHostPath: true})
		hr.Target = "/dest-parent/" + filepath.Base(u.Dest)
	}
	b, _ := json.Marshal(hr)
	spec := domain.ContainerSpec{
		Image: r.req.AgentImage, Entrypoint: []string{"/dockflow", "upload-helper"},
		Env: []string{HelperEnv + "=" + string(b)}, Restart: "no", Mounts: mounts,
	}
	labels := map[string]string{
		domain.LabelProject: r.stack, domain.LabelKind: domain.KindHelper, domain.LabelSchema: "1",
		domain.LabelManagedBy: "true", domain.LabelOneOff: "True",
	}
	id, err := r.Engine.Create(ctx, "dockflow-upload-"+r.req.Run+"-"+strconv.Itoa(len(r.uploads)), spec, labels)
	if err != nil {
		return "", upload.Stats{}, err
	}
	defer func() { _ = r.Engine.Remove(context.WithoutCancel(ctx), id) }()
	if err := r.Engine.Start(ctx, id); err != nil {
		return "", upload.Stats{}, err
	}
	code, err := r.Engine.Wait(ctx, id)
	if err != nil {
		return "", upload.Stats{}, err
	}
	logs, _ := r.Engine.Logs(context.WithoutCancel(ctx), id, engine.LogOptions{Stderr: true})
	var out []byte
	if logs != nil {
		out, _ = io.ReadAll(logs)
		logs.Close()
	}
	if code != 0 {
		return "", upload.Stats{}, errs.Newf("upload.failed", errs.ExitRolledBack, "cannot write %s: %s", u.Dest, strings.TrimSpace(string(out)))
	}
	// the helper prints its counts, then the restore manifest's digest
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	var stats upload.Stats
	if len(lines) > 1 {
		_ = json.Unmarshal([]byte(lines[len(lines)-2]), &stats)
	}
	return lines[len(lines)-1], stats, nil
}

// upload applies one upload of the plan.
func (r *runner) upload(ctx context.Context, desired *domain.App, dest string) error {
	for _, u := range desired.Uploads {
		if u.Dest != dest {
			continue
		}
		baseline, stats, err := r.applyUpload(ctx, u, u.Manifest, u.Mirror)
		if err != nil {
			return err
		}
		r.uploads = append(r.uploads, appliedUpload{upload: u, baseline: baseline})
		r.ev.Info(events.UploadFinished, fmt.Sprintf("uploaded to %s (%d changed, %d deleted)", dest, stats.Changed, stats.Deleted),
			map[string]any{"dest": dest, "files_changed": stats.Changed, "files_deleted": stats.Deleted})
		return nil
	}
	return errs.Internal("no upload to %s", dest)
}

// undoUploads restores the destinations the run changed, newest first.
func (r *runner) undoUploads(ctx context.Context) error {
	var failed []string
	for i := len(r.uploads) - 1; i >= 0; i-- {
		a := r.uploads[i]
		if _, _, err := r.applyUpload(ctx, a.upload, a.baseline, false); err != nil {
			failed = append(failed, err.Error())
		}
	}
	r.uploads = nil
	if len(failed) > 0 {
		return fmt.Errorf("%s", strings.Join(failed, "; "))
	}
	return nil
}

// forgetBaselines drops the restore manifests of a run that committed; pruning removes them.
func (r *runner) forgetBaselines() {
	r.uploads = nil
}

// pruneUploads deletes the manifests and blobs no kept release uses.
func (r *runner) pruneUploads(kept []*domain.Release) {
	blobs, manifests := uploadDirs(r.app)
	keepManifest := map[string]bool{}
	keepBlob := map[string]bool{}
	for _, rel := range kept {
		for _, u := range rel.Desired.Uploads {
			keepManifest[strings.TrimPrefix(u.Manifest, "sha256:")+".json"] = true
			b, err := os.ReadFile(manifestPath(r.app, u.Manifest))
			if err != nil {
				continue
			}
			var m upload.Manifest
			if json.Unmarshal(b, &m) == nil {
				for _, sum := range m.Blobs() {
					keepBlob[sum] = true
				}
			}
		}
	}
	entries, _ := os.ReadDir(manifests)
	for _, e := range entries {
		if !keepManifest[e.Name()] {
			_ = os.Remove(filepath.Join(manifests, e.Name()))
		}
	}
	entries, _ = os.ReadDir(blobs)
	for _, e := range entries {
		if !keepBlob[e.Name()] {
			_ = os.Remove(filepath.Join(blobs, e.Name()))
		}
	}
}
