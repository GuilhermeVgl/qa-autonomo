package bug

import "testing"

func TestTitle_SaysTheRouteOnceAndLeavesTheRetryNoteOut(t *testing.T) {
	cases := []struct{ key, label, actual, want string }{
		{"PAGE /customers/:id", "/customers/:id", "HTTP 500 (falhou nas 2 tentativas)", "/customers/:id: HTTP 500"},
		{"REQ-001", "/orders", "HTTP 500", "REQ-001 · /orders: HTTP 500"},
		{"", "/orders", "HTTP 404", "/orders: HTTP 404"},
		{"FORM POST /clients", "/clients/new", "aceitou o envio vazio: POST /clients → 302", "FORM POST /clients · /clients/new: aceitou o envio vazio: POST /clients → 302"},
	}
	for _, c := range cases {
		if got := title(c.key, c.label, c.actual); got != c.want {
			t.Errorf("title(%q, %q, %q) = %q, want %q", c.key, c.label, c.actual, got, c.want)
		}
	}
}

func TestNormalizeSignature_IgnoresTheRetryNote(t *testing.T) {
	a := NormalizeSignature("HTTP 500 (falhou nas 2 tentativas)")
	b := NormalizeSignature("HTTP 500")
	if a != b {
		t.Errorf("%q != %q: the number of tries is not part of the defect", a, b)
	}
	if NormalizeSignature("HTTP 500") == NormalizeSignature("HTTP 404") {
		t.Error("the status code still tells defects apart")
	}
}

func TestRouteFingerprint_DoesNotDependOnTheUser(t *testing.T) {
	if RouteFingerprint("/orders", "REQ-1", "HTTP 500") != RouteFingerprint("/orders", "REQ-1", "http 500 (falhou nas 2 tentativas)") {
		t.Error("same route, requirement and error must give the same fingerprint")
	}
	if RouteFingerprint("/orders", "REQ-1", "HTTP 500") == RouteFingerprint("/customers", "REQ-1", "HTTP 500") {
		t.Error("another route is another bug")
	}
}
