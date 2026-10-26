//go:build !linux

package agent

// onTmpfs: the agent runs on Linux only.
func onTmpfs(string) (bool, error) { return false, nil }
