// Package config parses every MOCKCLOUD_* environment variable once.
// Defaults match src/index.js, src/middleware/http.js and the service
// modules — the env contract is part of the conformance surface (the test
// harness drives both implementations through the same variables).
package config

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Version mirrors package.json — reported by /mockcloud/health and the banner.
const Version = "1.2.1"

type Config struct {
	Port    int
	UIPort  int
	Host    string
	UIOn    bool
	S3Root  string
	DDBRoot string

	DDBPersistOff  bool
	PollIntervalMs int
	AllowedOrigins []string
	TestEndpoints  bool
	ExitOnStdinEOF bool
	VerifySigV4    bool
	IAMMode        string // off | soft | strict
	MaxInternalInvokes int
	MaxLogStreams      int
	NodeBin            string
	EnableTerminal     string
}

func truthy(v string) bool {
	switch strings.ToLower(v) {
	case "true", "1", "yes":
		return true
	}
	return false
}

func intOr(v string, def int) int {
	if n, err := strconv.Atoi(v); err == nil {
		return n
	}
	return def
}

func Load() *Config {
	home, _ := os.UserHomeDir()
	c := &Config{
		Port:    intOr(os.Getenv("PORT"), 4566),
		UIPort:  intOr(os.Getenv("UI_PORT"), 4567),
		Host:    os.Getenv("HOST"),
		UIOn:    !truthy(os.Getenv("MOCKCLOUD_DISABLE_UI")),
		S3Root:  os.Getenv("MOCKCLOUD_S3_ROOT"),
		DDBRoot: os.Getenv("MOCKCLOUD_DYNAMODB_ROOT"),

		DDBPersistOff:      os.Getenv("MOCKCLOUD_DYNAMODB_PERSIST") == "off",
		PollIntervalMs:     intOr(os.Getenv("MOCKCLOUD_POLL_INTERVAL_MS"), 1000),
		TestEndpoints:      os.Getenv("MOCKCLOUD_TEST_ENDPOINTS") == "1",
		ExitOnStdinEOF:     os.Getenv("MOCKCLOUD_EXIT_ON_STDIN_CLOSE") == "1",
		VerifySigV4:        os.Getenv("MOCKCLOUD_VERIFY_SIGV4") == "true",
		IAMMode:            os.Getenv("MOCKCLOUD_IAM"),
		MaxInternalInvokes: intOr(os.Getenv("MOCKCLOUD_MAX_INTERNAL_INVOKES"), 200),
		MaxLogStreams:      intOr(os.Getenv("MOCKCLOUD_MAX_LOG_STREAMS"), 200),
		NodeBin:            os.Getenv("MOCKCLOUD_NODE_BIN"),
		EnableTerminal:     os.Getenv("MOCKCLOUD_ENABLE_TERMINAL"),
	}
	if c.Host == "" {
		c.Host = "127.0.0.1"
	}
	if c.S3Root == "" {
		c.S3Root = filepath.Join(home, ".mockcloud", "s3")
	}
	if c.DDBRoot == "" {
		c.DDBRoot = filepath.Join(home, ".mockcloud", "dynamodb")
	}
	if c.IAMMode == "" {
		c.IAMMode = "off"
	}
	for _, o := range strings.Split(os.Getenv("MOCKCLOUD_ALLOWED_ORIGINS"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			c.AllowedOrigins = append(c.AllowedOrigins, o)
		}
	}
	return c
}
