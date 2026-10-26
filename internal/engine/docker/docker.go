// Package docker implements the engine port on the Docker Engine API (ADR-0005).
package docker

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"sort"
	"strconv"
	"strings"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/distribution/reference"
	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/api/types/registry"
	"github.com/moby/moby/client"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"

	"github.com/Shawiizz/dockflow/internal/domain"
	"github.com/Shawiizz/dockflow/internal/engine"
	"github.com/Shawiizz/dockflow/internal/errs"
)

// Engine is the Docker adapter.
type Engine struct {
	c *client.Client
}

var _ engine.Engine = (*Engine)(nil)

// Dialer opens a connection to the Docker API.
type Dialer func(ctx context.Context, network, addr string) (net.Conn, error)

// New connects to the Docker Engine through dial, or to the local socket when dial is nil.
func New(dial Dialer) (*Engine, error) {
	var opts []client.Opt
	if dial != nil {
		opts = append(opts, client.WithHost("http://docker.sock"), client.WithDialContext(dial))
	} else {
		opts = append(opts, client.FromEnv)
	}
	c, err := client.New(opts...)
	if err != nil {
		return nil, errs.Connect("cannot set up the Docker client").WithCause(err)
	}
	return &Engine{c: c}, nil
}

// Close releases the client.
func (e *Engine) Close() error { return e.c.Close() }

func (e *Engine) Info(ctx context.Context) (engine.Info, error) {
	r, err := e.c.Info(ctx, client.InfoOptions{})
	if err != nil {
		return engine.Info{}, errs.Connect("the Docker API does not answer").WithCause(err).
			WithHint("check that Docker runs on the server and that the user may use its socket")
	}
	return engine.Info{
		Name: r.Info.Name, OS: r.Info.OSType, Arch: normaliseArch(r.Info.Architecture),
		EngineVersion: r.Info.ServerVersion, APIVersion: e.c.ClientVersion(),
	}, nil
}

func normaliseArch(a string) string {
	switch a {
	case "x86_64":
		return "amd64"
	case "aarch64":
		return "arm64"
	}
	return a
}

func labelFilter(labels map[string]string) client.Filters {
	f := client.Filters{}
	for k, v := range labels {
		if v == "" {
			f.Add("label", k)
		} else {
			f.Add("label", k+"="+v)
		}
	}
	return f
}

func (e *Engine) Containers(ctx context.Context, f engine.Filter) ([]engine.Container, error) {
	r, err := e.c.ContainerList(ctx, client.ContainerListOptions{All: f.All, Filters: labelFilter(f.Labels)})
	if err != nil {
		return nil, apiErr("list containers", err)
	}
	out := make([]engine.Container, 0, len(r.Items))
	for _, s := range r.Items {
		c := engine.Container{Labels: s.Labels, Image: s.Image}
		c.ID = s.ID
		if len(s.Names) > 0 {
			c.Name = strings.TrimPrefix(s.Names[0], "/")
		}
		c.State = string(s.State)
		if s.Health != nil {
			c.Health = string(s.Health.Status)
		}
		fillFromLabels(&c)
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func fillFromLabels(c *engine.Container) {
	c.Service = c.Labels[domain.LabelService]
	c.Hash = c.Labels[domain.LabelHash]
	c.OneOff = c.Labels[domain.LabelOneOff] == "True"
	if r, err := strconv.Atoi(c.Labels[domain.LabelRelease]); err == nil {
		c.Release = r
	}
}

func (e *Engine) Inspect(ctx context.Context, id string) (engine.Container, error) {
	r, err := e.c.ContainerInspect(ctx, id, client.ContainerInspectOptions{})
	if err != nil {
		return engine.Container{}, apiErr("inspect container "+id, err)
	}
	i := r.Container
	c := engine.Container{RestartCount: i.RestartCount}
	c.ID = i.ID
	c.Name = strings.TrimPrefix(i.Name, "/")
	if i.Config != nil {
		c.Labels = i.Config.Labels
		c.Image = i.Config.Image
	}
	if s := i.State; s != nil {
		c.State = string(s.Status)
		c.ExitCode = s.ExitCode
		c.OOMKilled = s.OOMKilled
		c.Error = s.Error
		if s.Health != nil {
			c.Health = string(s.Health.Status)
			c.FailingStreak = s.Health.FailingStreak
			if n := len(s.Health.Log); n > 0 && s.Health.Log[n-1] != nil {
				c.HealthLog = strings.TrimSpace(s.Health.Log[n-1].Output)
			}
		}
	}
	if ns := i.NetworkSettings; ns != nil {
		c.IPs = map[string]string{}
		for name, ep := range ns.Networks {
			if ep != nil && ep.IPAddress.IsValid() {
				c.IPs[name] = ep.IPAddress.String()
			}
		}
	}
	fillFromLabels(&c)
	return c, nil
}

func (e *Engine) Create(ctx context.Context, name string, spec domain.ContainerSpec, labels map[string]string) (string, error) {
	cfg, host, net, platform, err := toDocker(spec, labels)
	if err != nil {
		return "", err
	}
	r, err := e.c.ContainerCreate(ctx, client.ContainerCreateOptions{
		Name: name, Config: cfg, HostConfig: host, NetworkingConfig: net, Platform: platform,
	})
	if err != nil {
		return "", apiErr("create container "+name, err)
	}
	return r.ID, nil
}

func (e *Engine) Start(ctx context.Context, id string) error {
	if _, err := e.c.ContainerStart(ctx, id, client.ContainerStartOptions{}); err != nil {
		return apiErr("start container "+id, err)
	}
	return nil
}

func (e *Engine) Stop(ctx context.Context, id string, grace *time.Duration) error {
	o := client.ContainerStopOptions{}
	if grace != nil {
		s := int(grace.Seconds())
		o.Timeout = &s
	}
	if _, err := e.c.ContainerStop(ctx, id, o); err != nil && !cerrdefs.IsNotFound(err) {
		return apiErr("stop container "+id, err)
	}
	return nil
}

func (e *Engine) Remove(ctx context.Context, id string) error {
	_, err := e.c.ContainerRemove(ctx, id, client.ContainerRemoveOptions{Force: true})
	if err != nil && !cerrdefs.IsNotFound(err) && !cerrdefs.IsConflict(err) {
		return apiErr("remove container "+id, err)
	}
	return nil
}

func (e *Engine) Kill(ctx context.Context, id, signal string) error {
	if _, err := e.c.ContainerKill(ctx, id, client.ContainerKillOptions{Signal: signal}); err != nil && !cerrdefs.IsNotFound(err) {
		return apiErr("kill container "+id, err)
	}
	return nil
}

func (e *Engine) Rename(ctx context.Context, id, name string) error {
	if _, err := e.c.ContainerRename(ctx, id, client.ContainerRenameOptions{NewName: name}); err != nil {
		return apiErr("rename container "+id, err)
	}
	return nil
}

func (e *Engine) Attach(ctx context.Context, id string, tty bool) (*engine.Attached, error) {
	r, err := e.c.ContainerAttach(ctx, id, client.ContainerAttachOptions{Stream: true, Stdin: true, Stdout: true, Stderr: true})
	if err != nil {
		return nil, apiErr("attach to "+id, err)
	}
	return attached(r.HijackedResponse, tty), nil
}

// attached splits a hijacked connection into streams: raw with a TTY, demultiplexed without.
func attached(h client.HijackedResponse, tty bool) *engine.Attached {
	in := closeWriter{h.Conn, func() error { return h.CloseWrite() }}
	if tty {
		return &engine.Attached{Stdin: in, Stdout: h.Reader, Stderr: strings.NewReader(""), Close: func() { h.Close() }}
	}
	outR, outW := io.Pipe()
	errR, errW := io.Pipe()
	go func() {
		_, err := stdcopy.StdCopy(outW, errW, h.Reader)
		outW.CloseWithError(err)
		errW.CloseWithError(err)
	}()
	return &engine.Attached{Stdin: in, Stdout: outR, Stderr: errR, Close: func() { h.Close() }}
}

func (e *Engine) Resize(ctx context.Context, id string, width, height uint) error {
	if _, err := e.c.ContainerResize(ctx, id, client.ContainerResizeOptions{Width: width, Height: height}); err != nil {
		return apiErr("resize "+id, err)
	}
	return nil
}

func (e *Engine) Exec(ctx context.Context, id string, o engine.ExecOptions) (*engine.Exec, error) {
	size := client.ConsoleSize{Height: o.Height, Width: o.Width}
	created, err := e.c.ExecCreate(ctx, id, client.ExecCreateOptions{
		Cmd: o.Cmd, Env: o.Env, User: o.User, WorkingDir: o.WorkingDir, TTY: o.TTY, ConsoleSize: size,
		AttachStdin: o.Stdin, AttachStdout: true, AttachStderr: true,
	})
	if err != nil {
		return nil, apiErr("run a command in "+id, err)
	}
	r, err := e.c.ExecAttach(ctx, created.ID, client.ExecAttachOptions{TTY: o.TTY, ConsoleSize: size})
	if err != nil {
		return nil, apiErr("attach to the command in "+id, err)
	}
	execID := created.ID
	return &engine.Exec{
		Attached: *attached(r.HijackedResponse, o.TTY),
		Resize: func(ctx context.Context, w, h uint) error {
			_, err := e.c.ExecResize(ctx, execID, client.ExecResizeOptions{Width: w, Height: h})
			return err
		},
		Wait: func(ctx context.Context) (int, error) {
			for {
				res, err := e.c.ExecInspect(ctx, execID, client.ExecInspectOptions{})
				if err != nil {
					return -1, apiErr("inspect the command in "+id, err)
				}
				if !res.Running {
					return res.ExitCode, nil
				}
				select {
				case <-ctx.Done():
					return -1, ctx.Err()
				case <-time.After(100 * time.Millisecond):
				}
			}
		},
	}, nil
}

func (e *Engine) CopyTo(ctx context.Context, id, dir string, tar io.Reader) error {
	if _, err := e.c.CopyToContainer(ctx, id, client.CopyToContainerOptions{DestinationPath: dir, Content: tar}); err != nil {
		return apiErr("copy files into "+id, err)
	}
	return nil
}

func (e *Engine) CopyFrom(ctx context.Context, id, path string) (io.ReadCloser, error) {
	r, err := e.c.CopyFromContainer(ctx, id, client.CopyFromContainerOptions{SourcePath: path})
	if err != nil {
		if cerrdefs.IsNotFound(err) {
			return nil, errs.Usage("%s does not exist in the container", path)
		}
		return nil, apiErr("copy files from "+id, err)
	}
	return r.Content, nil
}

func (e *Engine) Images(ctx context.Context) ([]engine.Image, error) {
	r, err := e.c.ImageList(ctx, client.ImageListOptions{})
	if err != nil {
		return nil, apiErr("list images", err)
	}
	out := make([]engine.Image, 0, len(r.Items))
	for _, i := range r.Items {
		out = append(out, engine.Image{ID: i.ID, Tags: i.RepoTags, Digests: i.RepoDigests, Size: i.Size, Created: i.Created, Containers: i.Containers})
	}
	return out, nil
}

type closeWriter struct {
	io.Writer
	close func() error
}

func (c closeWriter) Close() error { return c.close() }

func (e *Engine) Wait(ctx context.Context, id string) (int, error) {
	r := e.c.ContainerWait(ctx, id, client.ContainerWaitOptions{Condition: container.WaitConditionNotRunning})
	select {
	case res := <-r.Result:
		if res.Error != nil && res.Error.Message != "" {
			return int(res.StatusCode), errs.Internal("waiting for %s: %s", id, res.Error.Message)
		}
		return int(res.StatusCode), nil
	case err := <-r.Error:
		return -1, apiErr("wait for "+id, err)
	}
}

func (e *Engine) Logs(ctx context.Context, id string, o engine.LogOptions) (io.ReadCloser, error) {
	r, err := e.c.ContainerLogs(ctx, id, client.ContainerLogsOptions{
		ShowStdout: true, ShowStderr: o.Stderr, Follow: o.Follow, Tail: o.Tail, Since: o.Since, Timestamps: o.Timestamps,
	})
	if err != nil {
		return nil, apiErr("read the logs of "+id, err)
	}
	pr, pw := io.Pipe()
	go func() {
		errOut := io.Discard
		if o.Stderr {
			errOut = pw
		}
		_, err := stdcopy.StdCopy(pw, errOut, r)
		r.Close()
		pw.CloseWithError(err)
	}()
	return pr, nil
}

// crashLoop is how many restarts during a rollout count as a crash loop.
const crashLoop = 3

func (e *Engine) WaitHealthy(ctx context.Context, id string, grace, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	var runningSince time.Time
	lastRestarts := -1
	for {
		c, err := e.Inspect(ctx, id)
		if err != nil {
			if ctx.Err() != nil {
				return timeoutErr(ctx, id, timeout)
			}
			return err
		}
		if lastRestarts >= 0 && c.RestartCount != lastRestarts {
			runningSince = time.Time{}
		}
		lastRestarts = c.RestartCount
		switch {
		case c.RestartCount >= crashLoop:
			return &engine.HealthError{Container: c.Name, Kind: "crash_loop", Reason: fmt.Sprintf("restarted %d times (last exit code %d)", c.RestartCount, c.ExitCode)}
		case c.State == "exited" || c.State == "dead":
			reason := fmt.Sprintf("exited with code %d", c.ExitCode)
			if c.OOMKilled {
				reason += " (out of memory)"
			}
			if c.Error != "" {
				reason += ": " + c.Error
			}
			return &engine.HealthError{Container: c.Name, Kind: "exited", Reason: reason}
		case c.Health == "unhealthy":
			return &engine.HealthError{Container: c.Name, Kind: "unhealthy", Reason: "unhealthy"}
		case c.Health == "healthy":
			return nil
		case c.State == "running" && (c.Health == "" || c.Health == "none"):
			if runningSince.IsZero() {
				runningSince = time.Now()
			}
			if time.Since(runningSince) >= grace {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return timeoutErr(ctx, id, timeout)
		case <-tick.C:
		}
	}
}

func timeoutErr(ctx context.Context, id string, timeout time.Duration) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return &engine.HealthError{Container: id, Kind: "timeout", Reason: fmt.Sprintf("not healthy after %s", timeout)}
	}
	return ctx.Err()
}

func (e *Engine) Networks(ctx context.Context) (map[string]bool, error) {
	r, err := e.c.NetworkList(ctx, client.NetworkListOptions{})
	if err != nil {
		return nil, apiErr("list networks", err)
	}
	out := map[string]bool{}
	for _, n := range r.Items {
		out[n.Name] = true
	}
	return out, nil
}

func (e *Engine) CreateNetwork(ctx context.Context, n domain.Network, project string) error {
	labels := map[string]string{}
	for k, v := range n.Labels {
		labels[k] = v
	}
	if project != "" {
		labels[domain.LabelProject] = project
		labels[domain.LabelNetwork] = n.Key
	}
	labels[domain.LabelManagedBy] = "true"
	_, err := e.c.NetworkCreate(ctx, n.Name, client.NetworkCreateOptions{
		Driver: n.Driver, Internal: n.Internal, Attachable: true, Labels: labels,
	})
	if err != nil && !cerrdefs.IsConflict(err) && !cerrdefs.IsAlreadyExists(err) {
		return apiErr("create network "+n.Name, err)
	}
	return nil
}

func (e *Engine) Connect(ctx context.Context, net, ctr string, aliases []string) error {
	_, err := e.c.NetworkConnect(ctx, net, client.NetworkConnectOptions{
		Container: ctr, EndpointConfig: &network.EndpointSettings{Aliases: aliases},
	})
	if err != nil && !strings.Contains(err.Error(), "already exists") {
		return apiErr("connect "+ctr+" to "+net, err)
	}
	return nil
}

func (e *Engine) Disconnect(ctx context.Context, net, ctr string) error {
	_, err := e.c.NetworkDisconnect(ctx, net, client.NetworkDisconnectOptions{Container: ctr, Force: true})
	if err != nil && !cerrdefs.IsNotFound(err) && !strings.Contains(err.Error(), "is not connected") {
		return apiErr("disconnect "+ctr+" from "+net, err)
	}
	return nil
}

func (e *Engine) RemoveNetwork(ctx context.Context, name string) error {
	if _, err := e.c.NetworkRemove(ctx, name, client.NetworkRemoveOptions{}); err != nil && !cerrdefs.IsNotFound(err) {
		return apiErr("remove network "+name, err)
	}
	return nil
}

func (e *Engine) PruneNetworks(ctx context.Context) ([]string, error) {
	f := client.Filters{}
	f.Add("label!", domain.LabelManagedBy)
	r, err := e.c.NetworkPrune(ctx, client.NetworkPruneOptions{Filters: f})
	if err != nil {
		return nil, apiErr("prune networks", err)
	}
	return r.Report.NetworksDeleted, nil
}

func (e *Engine) RemoveVolume(ctx context.Context, name string) error {
	if _, err := e.c.VolumeRemove(ctx, name, client.VolumeRemoveOptions{}); err != nil && !cerrdefs.IsNotFound(err) {
		return apiErr("remove volume "+name, err)
	}
	return nil
}

func (e *Engine) PruneVolumes(ctx context.Context) ([]string, error) {
	f := client.Filters{}
	f.Add("label!", domain.LabelManagedBy)
	r, err := e.c.VolumePrune(ctx, client.VolumePruneOptions{Filters: f})
	if err != nil {
		return nil, apiErr("prune volumes", err)
	}
	return r.Report.VolumesDeleted, nil
}

func (e *Engine) Volumes(ctx context.Context) (map[string]bool, error) {
	r, err := e.c.VolumeList(ctx, client.VolumeListOptions{})
	if err != nil {
		return nil, apiErr("list volumes", err)
	}
	out := map[string]bool{}
	for _, v := range r.Items {
		out[v.Name] = true
	}
	return out, nil
}

func (e *Engine) CreateVolume(ctx context.Context, v domain.Volume, project string) error {
	labels := map[string]string{}
	for k, val := range v.Labels {
		labels[k] = val
	}
	if project != "" {
		labels[domain.LabelProject] = project
		labels[domain.LabelVolume] = v.Key
	}
	labels[domain.LabelManagedBy] = "true"
	_, err := e.c.VolumeCreate(ctx, client.VolumeCreateOptions{Name: v.Name, Driver: v.Driver, DriverOpts: v.DriverOpts, Labels: labels})
	if err != nil {
		return apiErr("create volume "+v.Name, err)
	}
	return nil
}

func (e *Engine) HasImage(ctx context.Context, ref string) (bool, error) {
	_, err := e.c.ImageInspect(ctx, ref)
	if err == nil {
		return true, nil
	}
	if cerrdefs.IsNotFound(err) {
		return false, nil
	}
	return false, apiErr("inspect image "+ref, err)
}

func (e *Engine) ResolveImage(ctx context.Context, ref, policy string, auth *engine.RegistryAuth) (string, error) {
	have, err := e.HasImage(ctx, ref)
	if err != nil {
		return "", err
	}
	switch policy {
	case "", "missing", "if_not_present":
		if !have {
			err = e.pull(ctx, ref, auth)
		}
	case "always":
		err = e.pull(ctx, ref, auth)
	case "never":
		if !have {
			return "", errs.Plan("plan.image_missing", "image %s is not on the server and pull_policy is never", ref)
		}
	default:
		return "", errs.Plan("plan.pull_policy", "pull_policy %q is not supported", policy).
			WithHint("use missing, always or never")
	}
	if err != nil {
		return "", err
	}
	r, err := e.c.ImageInspect(ctx, ref)
	if err != nil {
		return "", apiErr("inspect image "+ref, err)
	}
	return pin(ref, r.ID, r.RepoDigests), nil
}

// pin returns ref pinned to the digest its registry knows, or to the local image ID.
func pin(ref, id string, repoDigests []string) string {
	named, err := reference.ParseNormalizedNamed(ref)
	if err != nil {
		return id
	}
	if _, ok := named.(reference.Digested); ok {
		return ref
	}
	for _, rd := range repoDigests {
		d, err := reference.ParseNormalizedNamed(rd)
		if err != nil {
			continue
		}
		if d.Name() == named.Name() {
			return ref + "@" + d.(reference.Digested).Digest().String()
		}
	}
	return id
}

func (e *Engine) pull(ctx context.Context, ref string, auth *engine.RegistryAuth) error {
	opts := client.ImagePullOptions{}
	if auth != nil && authFor(ref, auth.Server) {
		b, _ := json.Marshal(registry.AuthConfig{Username: auth.Username, Password: auth.Password, ServerAddress: auth.Server})
		opts.RegistryAuth = base64.URLEncoding.EncodeToString(b)
	}
	r, err := e.c.ImagePull(ctx, ref, opts)
	if err == nil {
		err = r.Wait(ctx)
	}
	if err != nil {
		return errs.Plan("plan.image_missing", "cannot pull %s", ref).WithCause(err).
			WithHint("check the image name and that the server can reach the registry (and is logged in to it)")
	}
	return nil
}

// authFor tells whether ref lives on the registry server.
func authFor(ref, server string) bool {
	named, err := reference.ParseNormalizedNamed(ref)
	if err != nil {
		return false
	}
	host, _, _ := strings.Cut(server, "/")
	return reference.Domain(named) == host
}

func (e *Engine) ImportImage(ctx context.Context, tar io.Reader, ref string, changes []string) error {
	r, err := e.c.ImageImport(ctx, client.ImageImportSource{Source: tar, SourceName: "-"}, ref, client.ImageImportOptions{Changes: changes})
	if err != nil {
		return apiErr("import image "+ref, err)
	}
	defer r.Close()
	body, err := io.ReadAll(r)
	if err != nil {
		return apiErr("import image "+ref, err)
	}
	if strings.Contains(string(body), `"error"`) || strings.Contains(string(body), `"errorDetail"`) {
		return errs.Internal("import image %s: %s", ref, strings.TrimSpace(string(body)))
	}
	return nil
}

func (e *Engine) RemoveImage(ctx context.Context, ref string) error {
	if _, err := e.c.ImageRemove(ctx, ref, client.ImageRemoveOptions{}); err != nil && !cerrdefs.IsNotFound(err) && !cerrdefs.IsConflict(err) {
		return apiErr("remove image "+ref, err)
	}
	return nil
}

func apiErr(what string, err error) error {
	if client.IsErrConnectionFailed(err) {
		return errs.Connect("the Docker API is unreachable").WithCause(err)
	}
	if errors.Is(err, context.Canceled) {
		return err
	}
	return errs.New("engine.api", errs.ExitInternal, "Docker refused to "+what).WithCause(err)
}

// toDocker maps a container spec to the Engine API's create request.
func toDocker(s domain.ContainerSpec, labels map[string]string) (*container.Config, *container.HostConfig, *network.NetworkingConfig, *ocispec.Platform, error) {
	all := map[string]string{}
	for k, v := range s.Labels {
		all[k] = v
	}
	for k, v := range labels {
		all[k] = v
	}
	cfg := &container.Config{
		Image: s.Image, Cmd: s.Command, Entrypoint: s.Entrypoint, Env: s.Env, Labels: all,
		User: s.User, WorkingDir: s.WorkingDir, Hostname: s.Hostname, Domainname: s.DomainName,
		Tty: s.Tty, OpenStdin: s.StdinOpen, StopSignal: s.StopSignal,
		StdinOnce: s.StdinOnce, AttachStdin: s.StdinOnce, AttachStdout: s.StdinOnce, AttachStderr: s.StdinOnce,
	}
	if s.StopGrace != nil {
		sec := int(s.StopGrace.D().Seconds())
		cfg.StopTimeout = &sec
	}
	if h := s.Healthcheck; h != nil {
		hc := &container.HealthConfig{Test: h.Test}
		if h.Disable {
			hc.Test = []string{"NONE"}
		}
		if h.Interval != nil {
			hc.Interval = h.Interval.D()
		}
		if h.Timeout != nil {
			hc.Timeout = h.Timeout.D()
		}
		if h.StartPeriod != nil {
			hc.StartPeriod = h.StartPeriod.D()
		}
		if h.StartInterval != nil {
			hc.StartInterval = h.StartInterval.D()
		}
		if h.Retries != nil {
			hc.Retries = int(*h.Retries)
		}
		cfg.Healthcheck = hc
	}

	host := &container.HostConfig{
		NetworkMode: container.NetworkMode(s.NetworkMode), Privileged: s.Privileged, ReadonlyRootfs: s.ReadOnly,
		Init: s.Init, CapAdd: s.CapAdd, CapDrop: s.CapDrop, SecurityOpt: s.SecurityOpt, ExtraHosts: s.ExtraHosts,
		DNSSearch: s.DNSSearch, DNSOptions: s.DNSOptions, Tmpfs: s.Tmpfs, Sysctls: s.Sysctls, GroupAdd: s.GroupAdd,
		PidMode: container.PidMode(s.Pid), IpcMode: container.IpcMode(s.Ipc), ShmSize: s.ShmSize,
		RestartPolicy: restartPolicy(s.Restart),
	}
	for _, d := range s.DNS {
		a, err := netip.ParseAddr(d)
		if err != nil {
			return nil, nil, nil, nil, errs.Config("dns %q is not an IP address", d)
		}
		host.DNS = append(host.DNS, a)
	}
	if s.Logging != nil {
		host.LogConfig = container.LogConfig{Type: s.Logging.Driver, Config: s.Logging.Options}
	}
	r := s.Resources
	host.Memory = r.MemoryLimit
	host.MemoryReservation = r.MemoryReservation
	host.NanoCPUs = int64(r.CPUs * 1e9)
	if r.PidsLimit != 0 {
		p := r.PidsLimit
		host.PidsLimit = &p
	}
	for _, u := range s.Ulimits {
		host.Ulimits = append(host.Ulimits, &container.Ulimit{Name: u.Name, Soft: u.Soft, Hard: u.Hard})
	}
	for _, d := range s.Devices {
		perm := d.Permissions
		if perm == "" {
			perm = "rwm"
		}
		host.Devices = append(host.Devices, container.DeviceMapping{PathOnHost: d.Source, PathInContainer: d.Target, CgroupPermissions: perm})
	}

	cfg.ExposedPorts = network.PortSet{}
	for _, x := range s.Expose {
		if !strings.Contains(x, "/") {
			x += "/tcp"
		}
		p, err := network.ParsePort(x)
		if err != nil {
			return nil, nil, nil, nil, errs.Config("expose %q is not a port", x)
		}
		cfg.ExposedPorts[p] = struct{}{}
	}
	if len(s.Ports) > 0 {
		host.PortBindings = network.PortMap{}
	}
	for _, p := range s.Ports {
		proto := p.Protocol
		if proto == "" {
			proto = "tcp"
		}
		port, err := network.ParsePort(fmt.Sprintf("%d/%s", p.ContainerPort, proto))
		if err != nil {
			return nil, nil, nil, nil, errs.Config("port %d/%s is not valid", p.ContainerPort, proto)
		}
		b := network.PortBinding{HostPort: p.HostPort}
		if p.HostIP != "" {
			a, err := netip.ParseAddr(p.HostIP)
			if err != nil {
				return nil, nil, nil, nil, errs.Config("host_ip %q is not an IP address", p.HostIP)
			}
			b.HostIP = a
		}
		cfg.ExposedPorts[port] = struct{}{}
		host.PortBindings[port] = append(host.PortBindings[port], b)
	}

	for _, m := range s.Mounts {
		dm := mount.Mount{Type: mount.Type(m.Type), Source: m.Source, Target: m.Target, ReadOnly: m.ReadOnly}
		switch m.Type {
		case "bind":
			dm.BindOptions = &mount.BindOptions{CreateMountpoint: m.CreateHostPath}
		case "volume":
			if m.NoCopy {
				dm.VolumeOptions = &mount.VolumeOptions{NoCopy: true}
			}
		case "tmpfs":
			if m.TmpfsSize > 0 {
				dm.TmpfsOptions = &mount.TmpfsOptions{SizeBytes: m.TmpfsSize}
			}
		}
		host.Mounts = append(host.Mounts, dm)
	}

	var nc *network.NetworkingConfig
	if s.NetworkMode == "" && len(s.Networks) > 0 {
		// The first network is set at creation; the Engine API connects the others too since 1.44.
		host.NetworkMode = container.NetworkMode(s.Networks[0].Network)
		nc = &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{}}
		for _, a := range s.Networks {
			es := &network.EndpointSettings{Aliases: a.Aliases}
			if a.IPv4Address != "" || a.IPv6Address != "" {
				es.IPAMConfig = &network.EndpointIPAMConfig{}
				if a.IPv4Address != "" {
					ip, err := netip.ParseAddr(a.IPv4Address)
					if err != nil {
						return nil, nil, nil, nil, errs.Config("ipv4_address %q is not valid", a.IPv4Address)
					}
					es.IPAMConfig.IPv4Address = ip
				}
				if a.IPv6Address != "" {
					ip, err := netip.ParseAddr(a.IPv6Address)
					if err != nil {
						return nil, nil, nil, nil, errs.Config("ipv6_address %q is not valid", a.IPv6Address)
					}
					es.IPAMConfig.IPv6Address = ip
				}
			}
			nc.EndpointsConfig[a.Network] = es
		}
	}

	var platform *ocispec.Platform
	if s.Platform != "" {
		parts := strings.SplitN(s.Platform, "/", 3)
		platform = &ocispec.Platform{OS: parts[0]}
		if len(parts) > 1 {
			platform.Architecture = parts[1]
		}
		if len(parts) > 2 {
			platform.Variant = parts[2]
		}
	}
	return cfg, host, nc, platform, nil
}

func restartPolicy(s string) container.RestartPolicy {
	name, count, _ := strings.Cut(s, ":")
	rp := container.RestartPolicy{Name: container.RestartPolicyMode(name)}
	if name == "" {
		rp.Name = container.RestartPolicyDisabled
	}
	if n, err := strconv.Atoi(count); err == nil {
		rp.MaximumRetryCount = n
	}
	return rp
}
