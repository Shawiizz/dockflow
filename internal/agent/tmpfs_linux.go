package agent

import "syscall"

// Filesystems that keep files in memory only.
const (
	tmpfsMagic = 0x01021994
	ramfsMagic = 0x858458f6
)

// onTmpfs reports whether dir is in memory.
func onTmpfs(dir string) (bool, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return false, err
	}
	return st.Type == tmpfsMagic || st.Type == ramfsMagic, nil
}
