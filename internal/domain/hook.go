package domain

// Hook phases (ADR-0022).
const (
	HookBeforeBuild  = "before_build"
	HookAfterBuild   = "after_build"
	HookBeforeDeploy = "before_deploy"
	HookAfterDeploy  = "after_deploy"
	HookAfterFailure = "after_failure"
)

// Hook kinds: where a hook runs.
const (
	HookLocal = "local" // on the CLI's machine, in the project directory
	HookHost  = "host"  // on the server, over SSH
	HookExec  = "exec"  // in every running container of a service
)

// Hook is one hook entry of dockflow.yml.
type Hook struct {
	Phase string `json:"phase"`
	Name  string `json:"name"`
	Kind  string `json:"kind"`
	// Command is a shell command (local, host), or a script path (local).
	Command string `json:"command,omitempty"`
	Script  string `json:"script,omitempty"`
	// Exec and Service are an argv run in the containers of a service.
	Exec    []string `json:"exec,omitempty"`
	Service string   `json:"service,omitempty"`
	// Secrets are the secret keys the hook gets as environment variables.
	Secrets []string `json:"secrets,omitempty"`
	Timeout Duration `json:"timeout"`
	Fatal   bool     `json:"fatal"`
	// Env is the hook's environment, filled when it runs: built-ins, vars and its secrets.
	Env []string `json:"env,omitempty"`
}
