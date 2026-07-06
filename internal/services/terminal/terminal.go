// Package terminal — port of src/services/terminal.js: host-shell sessions
// with a ring buffer + SSE subscribers. Gated off by default (the route layer
// enforces MOCKCLOUD_ENABLE_TERMINAL + loopback). Sessions live here, not in
// the store — they're module-local in Node too.
package terminal

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Chunk is one buffered/streamed event: t "o" (stdout) | "e" (stderr) |
// "r" (result, with Code) | "x" (closed).
type Chunk struct {
	T    string `json:"t"`
	D    string `json:"d,omitempty"`
	Code *int   `json:"code,omitempty"`
}

type Session struct {
	ID      string
	mu      sync.Mutex
	buffer  []Chunk
	subs    map[int]func(Chunk)
	nextSub int
	closed  bool
	busy    bool
	proc    *exec.Cmd
}

type Manager struct {
	mu     sync.Mutex
	byID   map[string]*Session
	nextID int
}

func NewManager() *Manager { return &Manager{byID: map[string]*Session{}, nextID: 1} }

var cliEnv = map[string]string{
	"AWS_DEFAULT_REGION":    "us-east-1",
	"AWS_ENDPOINT_URL":      "http://localhost:4566",
	"AWS_ACCESS_KEY_ID":     "local",
	"AWS_SECRET_ACCESS_KEY": "local",
}

type winShell struct {
	typ  string // gitbash | wsl | cmd
	path string
}

var (
	detectOnce   sync.Once
	cachedShell  winShell
)

func detectWindowsShell() winShell {
	detectOnce.Do(func() {
		candidates := []string{
			`C:\Program Files\Git\bin\bash.exe`,
			`C:\Program Files (x86)\Git\bin\bash.exe`,
		}
		if up := os.Getenv("USERPROFILE"); up != "" {
			candidates = append(candidates, up+`\AppData\Local\Programs\Git\bin\bash.exe`)
		}
		for _, p := range candidates {
			if _, err := os.Stat(p); err == nil {
				cachedShell = winShell{"gitbash", p}
				return
			}
		}
		sysRoot := os.Getenv("SystemRoot")
		if sysRoot == "" {
			sysRoot = `C:\Windows`
		}
		if wsl := filepath.Join(sysRoot, "System32", "wsl.exe"); fileExists(wsl) {
			cachedShell = winShell{"wsl", wsl}
			return
		}
		comspec := os.Getenv("ComSpec")
		if comspec == "" {
			comspec = "cmd.exe"
		}
		cachedShell = winShell{"cmd", comspec}
	})
	return cachedShell
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

// CreateSession — only 'cli' is supported (EC2 Connect went away with Docker).
func (m *Manager) CreateSession(sessionType string) (string, error) {
	if sessionType != "cli" {
		return "", fmt.Errorf("Unsupported session type: %s — only 'cli' is available", sessionType)
	}
	m.mu.Lock()
	id := "sess-" + strconv.Itoa(m.nextID)
	m.nextID++
	s := &Session{ID: id, subs: map[int]func(Chunk){}}
	m.byID[id] = s
	m.mu.Unlock()

	shellLabel := "/bin/sh"
	if sh := os.Getenv("SHELL"); sh != "" {
		shellLabel = sh
	}
	if runtime.GOOS == "windows" {
		ws := detectWindowsShell()
		switch ws.typ {
		case "wsl":
			shellLabel = "WSL (bash)"
		case "gitbash":
			shellLabel = "Git Bash"
		default:
			shellLabel = "cmd.exe"
		}
	}
	label := shellLabel
	if len(label) > 42 {
		label = label[:42]
	}
	s.push(Chunk{T: "o", D: "╔══════════════════════════════════════════════════════╗\r\n" +
		"║      MockCloud CLI  —  pre-configured shell        ║\r\n" +
		"╠══════════════════════════════════════════════════════╣\r\n" +
		"║  shell   " + padEnd(label, 44) + "║\r\n" +
		"║  AWS_ENDPOINT_URL   = http://localhost:4566          ║\r\n" +
		"║  AWS_DEFAULT_REGION = us-east-1                     ║\r\n" +
		"╠══════════════════════════════════════════════════════╣\r\n" +
		"║  try:  aws s3 ls                                     ║\r\n" +
		"║        aws ec2 describe-instances                    ║\r\n" +
		"║        aws lambda list-functions                     ║\r\n" +
		"╚══════════════════════════════════════════════════════╝\r\n\r\n"})

	// Auto-expire after 30 min (unref'd in Node; a stray goroutine+timer here).
	t := time.AfterFunc(30*time.Minute, func() { m.CloseSession(id) })
	_ = t
	return id, nil
}

func padEnd(s string, n int) string {
	for len([]rune(s)) < n {
		s += " "
	}
	return s
}

func (m *Manager) Get(id string) *Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.byID[id]
}

func (s *Session) push(c Chunk) {
	s.mu.Lock()
	s.buffer = append(s.buffer, c)
	if len(s.buffer) > 8000 {
		s.buffer = s.buffer[1:]
	}
	subs := make([]func(Chunk), 0, len(s.subs))
	for _, fn := range s.subs {
		subs = append(subs, fn)
	}
	s.mu.Unlock()
	for _, fn := range subs {
		fn(c)
	}
}

// Subscribe registers a sink and returns the buffered backlog + an unsubscribe.
func (s *Session) Subscribe(fn func(Chunk)) ([]Chunk, func()) {
	s.mu.Lock()
	id := s.nextSub
	s.nextSub++
	s.subs[id] = fn
	backlog := append([]Chunk{}, s.buffer...)
	s.mu.Unlock()
	return backlog, func() {
		s.mu.Lock()
		delete(s.subs, id)
		s.mu.Unlock()
	}
}

func (s *Session) Closed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

// ExecCommand runs one short-lived process per command (avoids TTY/buffering
// issues), streaming stdout/stderr to subscribers.
func (m *Manager) ExecCommand(sessionID, command string) error {
	s := m.Get(sessionID)
	if s == nil {
		return fmt.Errorf("Session not found")
	}
	s.mu.Lock()
	if s.busy {
		s.mu.Unlock()
		return fmt.Errorf("A command is already running — press Ctrl+C to cancel")
	}
	s.busy = true
	s.mu.Unlock()

	name, args, env := buildCommand(command)
	proc := exec.Command(name, args...)
	proc.Env = env
	hideWindow(proc) // Node: windowsHide: true
	stdout, _ := proc.StdoutPipe()
	stderr, _ := proc.StderrPipe()
	s.mu.Lock()
	s.proc = proc
	s.mu.Unlock()

	if err := proc.Start(); err != nil {
		s.finish(func() { s.busy = false; s.proc = nil })
		s.push(Chunk{T: "e", D: "\r\nCould not run command: " + err.Error() + "\r\n"})
		s.push(Chunk{T: "r", Code: intp(1)})
		return nil
	}
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := stdout.Read(buf)
			if n > 0 {
				s.push(Chunk{T: "o", D: string(buf[:n])})
			}
			if err != nil {
				return
			}
		}
	}()
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := stderr.Read(buf)
			if n > 0 {
				s.push(Chunk{T: "e", D: string(buf[:n])})
			}
			if err != nil {
				return
			}
		}
	}()
	go func() {
		err := proc.Wait()
		code := 0
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				code = exitErr.ExitCode()
			} else {
				code = 1
			}
		}
		s.finish(func() { s.busy = false; s.proc = nil })
		s.push(Chunk{T: "r", Code: &code})
	}()
	return nil
}

func (s *Session) finish(fn func()) {
	s.mu.Lock()
	fn()
	s.mu.Unlock()
}

func buildCommand(command string) (string, []string, []string) {
	if runtime.GOOS == "windows" {
		ws := detectWindowsShell()
		switch ws.typ {
		case "wsl":
			var prefix []string
			for k, v := range cliEnv {
				prefix = append(prefix, "export "+k+"="+v)
			}
			return ws.path, []string{"--", "bash", "-c", strings.Join(prefix, "; ") + "; " + command}, os.Environ()
		case "gitbash":
			return ws.path, []string{"-c", command}, mergedEnv()
		default:
			return ws.path, []string{"/d", "/c", command}, mergedEnv()
		}
	}
	return "/bin/sh", []string{"-c", command}, mergedEnv()
}

func mergedEnv() []string {
	env := os.Environ()
	for k, v := range cliEnv {
		env = append(env, k+"="+v)
	}
	return env
}

func (m *Manager) Interrupt(sessionID string) {
	s := m.Get(sessionID)
	if s == nil {
		return
	}
	s.mu.Lock()
	proc := s.proc
	s.mu.Unlock()
	if proc != nil && proc.Process != nil {
		_ = proc.Process.Kill()
	}
}

func (m *Manager) CloseSession(id string) {
	m.mu.Lock()
	s := m.byID[id]
	delete(m.byID, id)
	m.mu.Unlock()
	if s == nil {
		return
	}
	s.mu.Lock()
	proc := s.proc
	s.closed = true
	s.mu.Unlock()
	if proc != nil && proc.Process != nil {
		_ = proc.Process.Kill()
	}
	s.push(Chunk{T: "x", D: "0"})
}

func intp(n int) *int { return &n }
