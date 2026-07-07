//go:build !embedui

// Default build: the console is not embedded (keeps plain `go build` working
// without a prebuilt ui/dist). The daemon falls back to MOCKCLOUD_UI_DIR or
// ./ui/dist on disk. Release binaries are built with `-tags embedui`.
package ui

import "io/fs"

// DistFS reports that no console is embedded in this build.
func DistFS() (fs.FS, bool) { return nil, false }
