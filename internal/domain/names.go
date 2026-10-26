package domain

import (
	"fmt"
	"regexp"
)

// Name rules (docs/design/spec/config-v1.md#names).
var (
	AppName     = regexp.MustCompile(`^[a-z][a-z0-9-]{0,22}[a-z0-9]$`)
	EnvName     = regexp.MustCompile(`^[a-z][a-z0-9]{0,11}$`)
	ServiceName = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,62}$`)
	KeyName     = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)
	ServerName  = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)
)

// Stack is the Compose project name of an environment.
func Stack(app, env string) string { return app + "-" + env }

// JobName is the container of a job in release seq.
func JobName(stack, service string, seq int) string {
	return fmt.Sprintf("%s-%s-%d-job", stack, service, seq)
}

// ContainerName is the name of the n-th container of a service in a release.
func ContainerName(stack, service string, release, n int) string {
	return fmt.Sprintf("%s-%s-%d-%d", stack, service, release, n)
}

// Labels Dockflow puts on the objects it creates (docs/design/spec/state-v1.md).
const (
	LabelProject   = "com.docker.compose.project"
	LabelService   = "com.docker.compose.service"
	LabelNumber    = "com.docker.compose.container-number"
	LabelOneOff    = "com.docker.compose.oneoff"
	LabelNetwork   = "com.docker.compose.network"
	LabelVolume    = "com.docker.compose.volume"
	LabelSchema    = "dockflow.schema"
	LabelRelease   = "dockflow.release"
	LabelKind      = "dockflow.kind"
	LabelHash      = "dockflow.hash"
	LabelManagedBy = "dockflow.managed"
)

// Kinds of Dockflow containers.
const (
	KindService  = "service"
	KindJob      = "job"
	KindRun      = "run"
	KindSwitch   = "switch"
	KindRegistry = "registry"
	KindHelper   = "helper"
)
