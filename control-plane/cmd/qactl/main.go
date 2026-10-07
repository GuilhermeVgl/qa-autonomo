// Command qactl creates and follows runs from CI pipelines.
package main

import (
	"net/http"
	"os"
	"time"

	"github.com/kpmg/agent-qa/control-plane/internal/qactl"
)

func main() {
	os.Exit(qactl.Main(os.Args[1:], os.Getenv, os.Stdout, os.Stderr, &http.Client{Timeout: 60 * time.Second}))
}
