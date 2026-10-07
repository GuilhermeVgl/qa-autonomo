// Package bug turns failed test steps into deduplicated bugs with their own life cycle (CLAUDE.md, seção 8.5).
package bug

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
)

var (
	httpStatus = regexp.MustCompile(`(?i)http (\d{3})`)
	uuidRe     = regexp.MustCompile(`(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
	hexRe      = regexp.MustCompile(`(?i)\b[0-9a-f]{8,}\b`)
	// either a protected status marker or any run of digits; only the latter is rewritten
	digitsRe = regexp.MustCompile(`http_status_\d{3}|\d+`)
)

// NormalizeSignature removes what changes between occurrences of the same failure (ids, hashes, durations)
// while keeping what identifies it, notably the HTTP status code.
func NormalizeSignature(actual string) string {
	s := strings.ToLower(strings.TrimSpace(retryNote.ReplaceAllString(actual, "")))
	s = httpStatus.ReplaceAllString(s, "http_status_$1")
	s = uuidRe.ReplaceAllString(s, "<id>")
	s = hexRe.ReplaceAllString(s, "<hex>")
	s = digitsRe.ReplaceAllStringFunc(s, func(m string) string {
		if strings.HasPrefix(m, "http_status_") {
			return m // keep the status code: 500 and 404 are different bugs
		}
		return "n"
	})
	return strings.Join(strings.Fields(s), " ")
}

// retryNote is what the runner appends when it tried a page twice: how many tries it took is not part of the defect.
var retryNote = regexp.MustCompile(`(?i)\s*\((?:falhou nas \d+ tentativas|passou na \d+ª tentativa[^)]*)\)`)

// RouteFingerprint = hash(route + requirement + normalized error signature). It does not depend on the user: the same
// route failing the same way for the admin and for the operator is one defect, with two occurrences.
func RouteFingerprint(routeLabel, requirementKey, actual string) string {
	sum := sha256.Sum256([]byte("route|" + routeLabel + "|" + requirementKey + "|" + NormalizeSignature(actual)))
	return hex.EncodeToString(sum[:])[:32]
}

// Fingerprint = hash(node + requirement + normalized error signature). It is how bugs were identified before they were
// deduplicated across users (a node belongs to one user); kept to find, and move, the bugs recorded that way.
func Fingerprint(nodeFingerprint, requirementKey, actual string) string {
	sum := sha256.Sum256([]byte(nodeFingerprint + "|" + requirementKey + "|" + NormalizeSignature(actual)))
	return hex.EncodeToString(sum[:])[:32]
}

// Security says that a step is a security check: which one, how serious a failure of it is, and what it looked at.
type Security struct {
	Check    string // xss-reflected, header-csp...
	Severity string // critical | high | normal
	// Scope is what the check looked at when that is narrower than the whole site: the route and the parameters for
	// an injection, empty for a header every screen should carry.
	Scope string
}

// SecurityFingerprint identifies a finding by what it is and where, never by the user or the wording of the message:
// the same hole found by the admin and by the operator, or in the next run, is one bug.
func SecurityFingerprint(check, scope string) string {
	sum := sha256.Sum256([]byte("sec|" + check + "|" + scope))
	return hex.EncodeToString(sum[:])[:32]
}

var transitions = map[string][]string{
	"new":            {"confirmed", "false_positive", "fixed"},
	"confirmed":      {"fixed", "false_positive"},
	"fixed":          {"reopened"},
	"reopened":       {"confirmed", "fixed", "false_positive"},
	"false_positive": {"reopened"},
}

// CanTransition reports whether a person may move a bug from one status to another.
// (Automatic moves, like fixed when a run passes, bypass this table.)
func CanTransition(from, to string) bool {
	for _, t := range transitions[from] {
		if t == to {
			return true
		}
	}
	return false
}

// SeverityFor maps the criticality of the requirement a bug violates to the bug severity.
func SeverityFor(criticality string) string {
	switch criticality {
	case "critical", "high":
		return criticality
	default:
		return "normal"
	}
}
