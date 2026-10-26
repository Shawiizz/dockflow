//go:build !unix

package agent

// diskUsage is unknown where the agent never runs.
func diskUsage(string) (free, total uint64) { return 0, 0 }
