// persistence.go — port of src/services/dynamodb/persistence.js: debounced
// (200ms) JSON snapshot of the whole tables map to <DDB_ROOT>/tables.json,
// hydrate-on-boot, persistNow, wipeDisk, all gated by
// MOCKCLOUD_DYNAMODB_PERSIST=off.
package dynamodb

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/mockcloud/mockcloud/internal/config"
	"github.com/mockcloud/mockcloud/internal/state"
	"github.com/mockcloud/mockcloud/internal/store"
)

type persistence struct {
	mu       sync.Mutex
	timer    *time.Timer
	hydrated bool

	st   *store.Store
	root string
	off  bool
}

func newPersistence(st *store.Store, cfg *config.Config) *persistence {
	return &persistence{st: st, root: cfg.DDBRoot, off: cfg.DDBPersistOff}
}

func (p *persistence) snapshotPath() string { return filepath.Join(p.root, "tables.json") }

// Hydrate loads the snapshot into the store. Idempotent (guarded) unless
// force=true; existing in-memory tables are never clobbered. PERSIST=off
// gates reads too — a snapshot from an earlier persisted session must not
// load into a purely in-memory run.
func (p *persistence) Hydrate(force bool) {
	p.mu.Lock()
	if p.hydrated && !force {
		p.mu.Unlock()
		return
	}
	p.hydrated = true
	p.mu.Unlock()

	if p.off {
		return
	}
	data, err := os.ReadFile(p.snapshotPath())
	if err != nil {
		return // !existsSync
	}
	var doc struct {
		Tables map[string]map[string]any `json:"tables"`
	}
	// Plain decode (no UseNumber): Node's JSON.parse gives float64 numbers.
	if err := json.Unmarshal(data, &doc); err != nil {
		fmt.Fprintf(os.Stderr, "[DynamoDB persistence] failed to hydrate: %v\n", err)
		return
	}
	p.st.With(func(st *state.State) {
		for name, t := range doc.Tables {
			if st.DynamoDB.Tables[name] == nil {
				st.DynamoDB.Tables[name] = t
			}
		}
	})
}

// Persist schedules a debounced snapshot write (call after every mutation).
// Safe to call while holding the store lock — the write happens on a timer
// goroutine.
func (p *persistence) Persist() {
	if p.off {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.timer != nil {
		return
	}
	p.timer = time.AfterFunc(200*time.Millisecond, func() {
		p.mu.Lock()
		p.timer = nil
		p.mu.Unlock()
		p.writeSnapshot()
	})
}

// PersistNow forces an immediate write (test hook / shutdown). Must be
// called WITHOUT the store lock held.
func (p *persistence) PersistNow() {
	p.mu.Lock()
	if p.timer != nil {
		p.timer.Stop()
		p.timer = nil
	}
	p.mu.Unlock()
	p.writeSnapshot()
}

// FlushPending writes only if a debounced write is pending (the shutdown
// signal path).
func (p *persistence) FlushPending() {
	p.mu.Lock()
	pending := p.timer != nil
	if pending {
		p.timer.Stop()
		p.timer = nil
	}
	p.mu.Unlock()
	if pending {
		p.writeSnapshot()
	}
}

func (p *persistence) writeSnapshot() {
	var tablesJSON string
	p.st.With(func(st *state.State) {
		anyTables := make(map[string]any, len(st.DynamoDB.Tables))
		for k, v := range st.DynamoDB.Tables {
			anyTables[k] = v
		}
		tablesJSON, _ = stringifyJSON(anyTables)
	})
	body := `{"version":1,"savedAt":` + fmt.Sprint(state.NowMs()) + `,"tables":` + tablesJSON + `}`
	if err := os.MkdirAll(p.root, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "[DynamoDB persistence] failed to persist: %v\n", err)
		return
	}
	target := p.snapshotPath()
	tmp := target + ".tmp-" + state.RandomID(8)
	if err := os.WriteFile(tmp, []byte(body), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "[DynamoDB persistence] failed to persist: %v\n", err)
		return
	}
	if err := os.Rename(tmp, target); err != nil {
		// rename can fail cross-device / when the target is busy on Windows —
		// fall back to a direct write, then drop the temp file.
		if werr := os.WriteFile(target, []byte(body), 0o644); werr != nil {
			fmt.Fprintf(os.Stderr, "[DynamoDB persistence] failed to persist: %v\n", werr)
		}
		_ = os.Remove(tmp)
	}
}

// WipeDisk removes the on-disk snapshot, cancels any pending debounced write
// (so a write queued just before a reset can't recreate the file), and
// resets the hydrate guard.
func (p *persistence) WipeDisk() {
	p.mu.Lock()
	if p.timer != nil {
		p.timer.Stop()
		p.timer = nil
	}
	p.hydrated = false
	p.mu.Unlock()
	_ = os.Remove(p.snapshotPath())
}

func (p *persistence) SnapshotExists() bool {
	_, err := os.Stat(p.snapshotPath())
	return err == nil
}

// ── Service-level wrappers (wiring surface for main.go / controlplane) ──────

// HydrateFromDisk restores tables at boot (or force-rehydrates for the
// _test/dynamodb/reload hook).
func (s *Service) HydrateFromDisk(force bool) { s.pers.Hydrate(force) }

// PersistNow — POST /mockcloud/_test/dynamodb/persist.
func (s *Service) PersistNow() { s.pers.PersistNow() }

// SnapshotExists — GET /mockcloud/_test/dynamodb/snapshot.
func (s *Service) SnapshotExists() bool { return s.pers.SnapshotExists() }

// WipeDisk — DELETE /mockcloud/reset (dynamodb scope).
func (s *Service) WipeDisk() { s.pers.WipeDisk() }

// FlushPendingSnapshot — the shutdown signal path.
func (s *Service) FlushPendingSnapshot() { s.pers.FlushPending() }

// TableNames returns the current table names (reload hook response).
func (s *Service) TableNames() []string {
	names := []string{}
	s.st.With(func(st *state.State) {
		for n := range st.DynamoDB.Tables {
			names = append(names, n)
		}
	})
	return names
}
