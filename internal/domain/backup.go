package domain

// Backup types (ADR-0015).
const (
	BackupPostgres = "postgres"
	BackupMySQL    = "mysql"
	BackupMongo    = "mongo"
	BackupRedis    = "redis"
	BackupVolume   = "volume"
	BackupCommand  = "command"
)

// Quiesce modes of a volume backup: how writes stop during the copy.
const (
	QuiesceStop = "stop"
	QuiesceNone = "none"
	QuiesceExec = "exec"
)

// Backup is how a stateful service is backed up and restored (x-dockflow.backup).
type Backup struct {
	Type string `json:"type"`
	// Database is the database dumped; empty for the image's default one.
	Database       string   `json:"database,omitempty"`
	DumpOptions    []string `json:"dump_options,omitempty"`
	RestoreOptions []string `json:"restore_options,omitempty"`
	// Volumes are the volume keys or absolute bind sources a volume backup copies; empty for
	// every volume and bind mount of the service.
	Volumes []string `json:"volumes,omitempty"`
	Quiesce Quiesce  `json:"quiesce"`
	// Dump writes the backup to its stdout, and Restore reads it on its stdin (command type).
	Dump    []string `json:"dump,omitempty"`
	Restore []string `json:"restore,omitempty"`
	Keep    *Keep    `json:"keep,omitempty"`
}

// Quiesce stops the writes of a volume backup: Pre and Post run in the running container with
// the exec mode.
type Quiesce struct {
	Mode string   `json:"mode"`
	Pre  []string `json:"pre,omitempty"`
	Post []string `json:"post,omitempty"`
}

// Keep is a retention, restic's --keep-* options.
type Keep struct {
	Last    int `json:"last,omitempty" yaml:"last"`
	Hourly  int `json:"hourly,omitempty" yaml:"hourly"`
	Daily   int `json:"daily,omitempty" yaml:"daily"`
	Weekly  int `json:"weekly,omitempty" yaml:"weekly"`
	Monthly int `json:"monthly,omitempty" yaml:"monthly"`
}

// Empty tells whether the retention keeps nothing in particular.
func (k *Keep) Empty() bool {
	return k == nil || (k.Last == 0 && k.Hourly == 0 && k.Daily == 0 && k.Weekly == 0 && k.Monthly == 0)
}

// DefaultKeep is the retention of a service that sets none.
var DefaultKeep = Keep{Last: 7, Daily: 14, Weekly: 8, Monthly: 6}
