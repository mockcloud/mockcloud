// Package background — the single tick loop (port of src/lifecycle.js).
// One goroutine, sequential ticks, per-tick panic recovery. Feature modules
// register ticks at wire-up; test determinism depends on "one tick = one
// poll pass", so keep this a single loop.
package background

import (
	"fmt"
	"os"
	"time"
)

type Ticker struct {
	interval time.Duration
	ticks    []func()
	stop     chan struct{}
	done     chan struct{}
}

func New(intervalMs int) *Ticker {
	if intervalMs <= 0 {
		intervalMs = 1000
	}
	return &Ticker{interval: time.Duration(intervalMs) * time.Millisecond}
}

func (t *Ticker) Register(fn func()) { t.ticks = append(t.ticks, fn) }

func (t *Ticker) Start() {
	t.stop = make(chan struct{})
	t.done = make(chan struct{})
	go func() {
		defer close(t.done)
		tick := time.NewTicker(t.interval)
		defer tick.Stop()
		for {
			select {
			case <-t.stop:
				return
			case <-tick.C:
				for _, fn := range t.ticks {
					t.runSafe(fn)
				}
			}
		}
	}()
}

func (t *Ticker) runSafe(fn func()) {
	defer func() {
		if e := recover(); e != nil {
			fmt.Fprintf(os.Stderr, "[lifecycle] tick failed: %v\n", e)
		}
	}()
	fn()
}

func (t *Ticker) Stop() {
	if t.stop == nil {
		return
	}
	close(t.stop)
	<-t.done
	t.stop = nil
}
