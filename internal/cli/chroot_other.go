//go:build !linux

package cli

import "errors"

func chrootHost(string) error { return errors.New("the filter helper runs on Linux only") }
