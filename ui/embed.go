//go:build embedui

// Package ui carries the prebuilt console (ui/dist) embedded into the binary.
// Enabled with `-tags embedui` (the release build, after `npm run ui:build`) —
// the resulting binary is fully self-contained. Plain `go build` (CI go-check,
// which has no built UI) uses the stub in embed_stub.go and serves from disk.
package ui

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var distFS embed.FS

// DistFS returns the embedded console filesystem rooted at dist/, and true.
func DistFS() (fs.FS, bool) {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		return nil, false
	}
	return sub, true
}
