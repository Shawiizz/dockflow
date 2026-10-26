// Package errs defines Dockflow's typed errors: a stable dotted code, a message, a hint saying
// what to do about it, and the CLI exit code it maps to (docs/design/spec/cli-v1.md).
package errs

import (
	"errors"
	"fmt"
)

// Exit codes, as listed in the CLI specification.
const (
	ExitOK          = 0
	ExitInternal    = 1
	ExitUsage       = 2
	ExitConfig      = 3
	ExitConnect     = 4
	ExitLocked      = 5
	ExitPlan        = 6
	ExitBuild       = 7
	ExitRolledBack  = 8
	ExitDegraded    = 9
	ExitLockLost    = 10
	ExitHook        = 11
	ExitInterrupted = 130
)

// Error is a failure Dockflow understands.
type Error struct {
	Code    string
	Message string
	Hint    string
	Exit    int
	Cause   error
	// Reported tells that the error was already reported in the event stream.
	Reported bool
}

func (e *Error) Error() string {
	if e.Cause != nil {
		return e.Message + ": " + e.Cause.Error()
	}
	return e.Message
}

func (e *Error) Unwrap() error { return e.Cause }

// New returns an error with the given code and exit code.
func New(code string, exit int, message string) *Error {
	return &Error{Code: code, Exit: exit, Message: message}
}

// Newf is New with a formatted message.
func Newf(code string, exit int, format string, args ...any) *Error {
	return New(code, exit, fmt.Sprintf(format, args...))
}

// WithHint returns the error with a hint.
func (e *Error) WithHint(format string, args ...any) *Error {
	e.Hint = fmt.Sprintf(format, args...)
	return e
}

// WithCause returns the error wrapping cause.
func (e *Error) WithCause(cause error) *Error {
	e.Cause = cause
	return e
}

// Config is an invalid configuration: dockflow.yml, Compose, secrets, a missing variable.
func Config(format string, args ...any) *Error {
	return Newf("config.invalid", ExitConfig, format, args...)
}

// Usage is a wrong use of the CLI.
func Usage(format string, args ...any) *Error {
	return Newf("usage.invalid", ExitUsage, format, args...)
}

// Connect is a failure to reach a server.
func Connect(format string, args ...any) *Error {
	return Newf("connect.failed", ExitConnect, format, args...)
}

// Plan is a plan that cannot be applied.
func Plan(code string, format string, args ...any) *Error {
	return Newf(code, ExitPlan, format, args...)
}

// Internal is a bug.
func Internal(format string, args ...any) *Error {
	return Newf("internal", ExitInternal, format, args...)
}

// As returns the *Error in err's chain, if any.
func As(err error) (*Error, bool) {
	var e *Error
	if errors.As(err, &e) {
		return e, true
	}
	return nil, false
}

// ExitCode returns the exit code an error maps to: the code of the first *Error in its chain,
// or ExitInternal for anything else.
func ExitCode(err error) int {
	if err == nil {
		return ExitOK
	}
	if e, ok := As(err); ok {
		return e.Exit
	}
	return ExitInternal
}

// CodeOf returns the dotted code of err, "internal" when it is not an *Error.
func CodeOf(err error) string {
	if e, ok := As(err); ok {
		return e.Code
	}
	return "internal"
}
