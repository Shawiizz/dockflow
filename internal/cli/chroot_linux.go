package cli

import (
	"os"
	"syscall"
)

func chrootHost(dir string) error {
	if err := syscall.Chroot(dir); err != nil {
		return err
	}
	return os.Chdir("/")
}
