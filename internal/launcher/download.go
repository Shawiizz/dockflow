package launcher

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"debug/elf"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/Shawiizz/dockflow/internal/errs"
	"github.com/Shawiizz/dockflow/internal/events"
	"github.com/Shawiizz/dockflow/internal/version"
)

// ReleasesURL is where the binaries of a release are downloaded from, under its tag, v<version>/.
// DOCKFLOW_RELEASES_URL overrides it (a mirror).
const ReleasesURL = "https://github.com/Shawiizz/dockflow/releases/download"

// maxBinary bounds a downloaded binary.
const maxBinary = 256 << 20

// agentBinary returns the path of the Linux binary to run as the agent on a server of the given
// architecture (ADR-0020): DOCKFLOW_AGENT_BINARY, this binary when it matches, or the agent of
// this version downloaded from its release, checked against the checksum this binary was built
// with (the release's SHA256SUMS for a build without one) and cached.
func (l *Launcher) agentBinary(ctx context.Context, arch string) (string, error) {
	if p := os.Getenv("DOCKFLOW_AGENT_BINARY"); p != "" {
		return p, nil
	}
	dynamic := false
	if runtime.GOOS == "linux" && runtime.GOARCH == arch {
		self, err := os.Executable()
		if err != nil {
			return "", errs.Internal("find this binary: %v", err)
		}
		// the agent's image holds the binary alone: no C library to link against
		if dynamic = !static(self); !dynamic {
			return self, nil
		}
	}
	if l.Version == "" || l.Version == "dev" || strings.HasPrefix(l.Version, "snapshot") {
		if dynamic {
			return "", errs.Newf("agent.no_binary", errs.ExitConnect, "this dockflow binary is linked dynamically, and cannot run as the agent, alone in its image").
				WithHint("build it with CGO_ENABLED=0, as make build does, or set DOCKFLOW_AGENT_BINARY to a static build")
		}
		return "", errs.Newf("agent.no_binary", errs.ExitConnect, "this dockflow binary is for %s/%s; the server runs linux/%s, and a development build has no release to download it from", runtime.GOOS, runtime.GOARCH, arch).
			WithHint("set DOCKFLOW_AGENT_BINARY to the path of the dockflow binary for linux/%s", arch)
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", errs.Internal("no cache directory: %v", err)
	}
	dir := filepath.Join(cache, "dockflow", l.Version)
	name := "dockflow-agent-linux-" + arch
	path := filepath.Join(dir, name)
	base := ReleasesURL
	if u := os.Getenv("DOCKFLOW_RELEASES_URL"); u != "" {
		base = strings.TrimSuffix(u, "/")
	}
	base += "/v" + strings.TrimPrefix(l.Version, "v") + "/"
	builtIn := version.AgentSum(arch)
	if _, err := os.Stat(path); err == nil {
		// checked again at every use: the cache is a file anyone with this user's rights can change
		want := builtIn
		if want == "" {
			if want, err = releaseSum(ctx, http.DefaultClient, base, name); err != nil {
				return "", err
			}
		}
		if got, err := fileSum(path); err == nil && got == want {
			return path, nil
		}
		l.Events.Warn(events.Warning, fmt.Sprintf("the cached agent binary %s does not match its checksum: downloading it again", path),
			map[string]any{"code": "agent.cache_mismatch", "detail": path})
		if err := os.Remove(path); err != nil {
			return "", errs.Internal("cache: %v", err)
		}
	}
	l.Events.Info(events.Log, fmt.Sprintf("downloading the agent binary for linux/%s", arch), map[string]any{"line": "download " + base + name})
	if err := Download(ctx, http.DefaultClient, base, name, builtIn, path); err != nil {
		return "", err
	}
	return path, nil
}

// fileSum returns the hex SHA-256 of the file at path.
func fileSum(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func downloadFailed(base, format string, a ...any) error {
	return errs.Newf("agent.download_failed", errs.ExitConnect, format, a...).
		WithHint("check that this machine can reach %s, or set DOCKFLOW_AGENT_BINARY to the dockflow binary for the server", base)
}

// releaseSum reads the checksum of name in base+SHA256SUMS.
func releaseSum(ctx context.Context, client *http.Client, base, name string) (string, error) {
	var sums bytes.Buffer
	if err := fetch(ctx, client, base+"SHA256SUMS", 1<<20, &sums); err != nil {
		return "", downloadFailed(base, "cannot download the checksums of the release: %v", err)
	}
	want := ""
	sc := bufio.NewScanner(&sums)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			want = f[0]
		}
	}
	if want == "" {
		return "", downloadFailed(base, "the release lists no %s", name)
	}
	return want, nil
}

// Download fetches base+name to path, after checking it against want, or against base+SHA256SUMS
// when want is empty.
func Download(ctx context.Context, client *http.Client, base, name, want, path string) error {
	failed := func(format string, a ...any) error { return downloadFailed(base, format, a...) }
	source := "the checksum this dockflow was built with"
	if want == "" {
		source = "the release's checksum"
		var err error
		if want, err = releaseSum(ctx, client, base, name); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return errs.Internal("cache directory: %v", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), name+".*")
	if err != nil {
		return errs.Internal("cache directory: %v", err)
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	err = fetch(ctx, client, base+name, maxBinary, io.MultiWriter(tmp, h))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return failed("cannot download %s: %v", name, err)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return errs.Newf("agent.checksum_mismatch", errs.ExitConnect, "the downloaded %s does not match %s (%s, want %s)", name, source, got, want).
			WithHint("nothing was sent to the server; try again, and report it if it persists")
	}
	if err := os.Chmod(tmp.Name(), 0o755); err != nil {
		return errs.Internal("cache: %v", err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return errs.Internal("cache: %v", err)
	}
	return nil
}

// fetch GETs url into w, refusing more than limit bytes.
func fetch(ctx context.Context, client *http.Client, url string, limit int64, w io.Writer) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: %s", url, resp.Status)
	}
	n, err := io.Copy(w, io.LimitReader(resp.Body, limit+1))
	if err == nil && n > limit {
		err = fmt.Errorf("%s is larger than %d bytes", url, limit)
	}
	return err
}

// static tells whether the ELF binary at path needs no dynamic loader.
func static(path string) bool {
	f, err := elf.Open(path)
	if err != nil {
		return false
	}
	defer func() { _ = f.Close() }()
	for _, p := range f.Progs {
		if p.Type == elf.PT_INTERP {
			return false
		}
	}
	return true
}
