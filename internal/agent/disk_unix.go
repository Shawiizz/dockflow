//go:build unix

package agent

import "syscall"

// diskUsage returns the free and total bytes of the filesystem holding path.
func diskUsage(path string) (free, total uint64) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0
	}
	return st.Bavail * uint64(st.Bsize), st.Blocks * uint64(st.Bsize)
}

// syncDisks writes the server's dirty pages to disk: the files a restore staged reach the disk
// before anything relies on them, as the state's files do.
func syncDisks() { syscall.Sync() }
