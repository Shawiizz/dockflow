//go:build !unix

package cli

// watchResize is a no-op where terminals send no resize signal.
func watchResize(func()) (stop func()) { return func() {} }
