package bug

import "testing"

func TestNormalizeSignature(t *testing.T) {
	cases := []struct{ a, b string }{
		{"HTTP 500", "http 500"},
		{"HTTP 200, structure changed (fingerprint 1a2b3c4d != 99aa88bb)", "HTTP 200, structure changed (fingerprint ffeeddcc != 0a1b2c3d)"},
		{"net::ERR_TIMED_OUT after 15000ms", "net::ERR_TIMED_OUT after 30000ms"},
		{"element 8f14e45f-ceea-467a-9575-2c2b3b8a3e0c missing", "element 11111111-2222-3333-4444-555555555555 missing"},
	}
	for _, c := range cases {
		if NormalizeSignature(c.a) != NormalizeSignature(c.b) {
			t.Errorf("signatures should match:\n  %q -> %q\n  %q -> %q", c.a, NormalizeSignature(c.a), c.b, NormalizeSignature(c.b))
		}
	}
	// different failures stay different: the HTTP status code is part of the signature
	if NormalizeSignature("HTTP 500") == NormalizeSignature("HTTP 404") {
		t.Error("500 and 404 must not collapse into one bug")
	}
	if NormalizeSignature("HTTP 500") == NormalizeSignature("structure changed") {
		t.Error("different failure kinds must differ")
	}
}

func TestFingerprint(t *testing.T) {
	a := Fingerprint("nodefp", "REQ-001", "HTTP 500")
	if a != Fingerprint("nodefp", "REQ-001", "http 500") {
		t.Error("fingerprint must ignore case/noise of the signature")
	}
	for name, other := range map[string]string{
		"node":        Fingerprint("other", "REQ-001", "HTTP 500"),
		"requirement": Fingerprint("nodefp", "REQ-002", "HTTP 500"),
		"error":       Fingerprint("nodefp", "REQ-001", "HTTP 404"),
	} {
		if a == other {
			t.Errorf("changing the %s must change the fingerprint", name)
		}
	}
	if len(a) != 32 {
		t.Errorf("len = %d, want 32 hex chars", len(a))
	}
}

func TestCanTransition(t *testing.T) {
	ok := [][2]string{
		{"new", "confirmed"}, {"new", "false_positive"}, {"new", "fixed"},
		{"confirmed", "fixed"}, {"confirmed", "false_positive"},
		{"fixed", "reopened"}, {"reopened", "confirmed"}, {"reopened", "fixed"}, {"reopened", "false_positive"},
		{"false_positive", "reopened"},
	}
	for _, c := range ok {
		if !CanTransition(c[0], c[1]) {
			t.Errorf("%s -> %s should be allowed", c[0], c[1])
		}
	}
	bad := [][2]string{{"new", "new"}, {"new", "reopened"}, {"fixed", "confirmed"}, {"false_positive", "fixed"}, {"confirmed", "new"}, {"x", "fixed"}}
	for _, c := range bad {
		if CanTransition(c[0], c[1]) {
			t.Errorf("%s -> %s should be rejected", c[0], c[1])
		}
	}
}

func TestSeverityFor(t *testing.T) {
	for crit, want := range map[string]string{"critical": "critical", "high": "high", "normal": "normal", "": "normal", "weird": "normal"} {
		if got := SeverityFor(crit); got != want {
			t.Errorf("SeverityFor(%q) = %q, want %q", crit, got, want)
		}
	}
}
