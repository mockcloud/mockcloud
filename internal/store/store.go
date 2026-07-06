// Package store serializes access to the global state.
//
// Concurrency model: ONE mutex over everything, mirroring Node's
// single-threaded event loop ("exclusive access between await points").
// Cross-service cascades mutate multiple namespaces atomically inside one
// With section, exactly like one event-loop turn.
//
// INVARIANT: fn must never block — no process spawns, no disk I/O on object
// bodies, no sleeps, no network writes inside With. Long operations split
// into lock → I/O → lock phases (see the Lambda invoke path).
package store

import (
	"sync"

	"github.com/mockcloud/mockcloud/internal/state"
)

type Store struct {
	mu sync.Mutex
	st *state.State
}

func New() *Store {
	return &Store{st: state.New()}
}

// With runs fn with exclusive access to the state.
func (s *Store) With(fn func(st *state.State)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn(s.st)
}
