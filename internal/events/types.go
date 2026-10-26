package events

// Event types, as listed in docs/design/spec/events-v1.md.
const (
	RunStarted       = "run.started"
	RunFinished      = "run.finished"
	ConfigLoaded     = "config.loaded"
	Warning          = "warning"
	LockWaiting      = "lock.waiting"
	LockAcquired     = "lock.acquired"
	LockReleased     = "lock.released"
	BuildStarted     = "build.started"
	BuildLog         = "build.log"
	BuildFinished    = "build.finished"
	PushFinished     = "push.finished"
	PlanComputed     = "plan.computed"
	PlanEmpty        = "plan.empty"
	ReleaseCreated   = "release.created"
	ActionStarted    = "action.started"
	ActionFinished   = "action.finished"
	ActionFailed     = "action.failed"
	ContainerState   = "container.state"
	ServiceHealthy   = "service.healthy"
	ServiceFailed    = "service.failed"
	SwitchChanged    = "switch.changed"
	DrainStarted     = "drain.started"
	RoutesApplied    = "routes.applied"
	RollbackStarted  = "rollback.started"
	RollbackFinished = "rollback.finished"
	CancelRequested  = "cancel.requested"
	Log              = "log"
	// Result carries the outcome of a read-only operation (status, releases, lock).
	Result = "result"
)

// Outcomes of a run, in run.finished.
const (
	OutcomeSuccess    = "success"
	OutcomeNoop       = "noop"
	OutcomeRolledBack = "rolled_back"
	OutcomeFailed     = "failed"
	OutcomeCancelled  = "cancelled"
	OutcomeLockLost   = "lock_lost"
	OutcomeHookFailed = "hook_failed"
)

// ErrorData is the error field of run.finished and action.failed.
type ErrorData struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Hint    string `json:"hint,omitempty"`
}

// RunFinishedData is the data of run.finished.
type RunFinishedData struct {
	Outcome    string     `json:"outcome"`
	ExitCode   int        `json:"exit_code"`
	ReleaseSeq int        `json:"release_seq,omitempty"`
	DurationMS int64      `json:"duration_ms"`
	Error      *ErrorData `json:"error,omitempty"`
}
