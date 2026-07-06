//go:build !windows

package terminal

import "os/exec"

// hideWindow is Windows-only (Node's `windowsHide: true`); no-op elsewhere.
func hideWindow(*exec.Cmd) {}
