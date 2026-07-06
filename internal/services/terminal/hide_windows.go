//go:build windows

package terminal

import (
	"os/exec"
	"syscall"
)

// hideWindow ports Node's `windowsHide: true` spawn option — command shells
// must not flash console windows on the host desktop.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}
