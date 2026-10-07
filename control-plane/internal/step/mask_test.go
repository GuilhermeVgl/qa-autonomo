package step

import (
	"encoding/json"
	"testing"
)

func TestMaskInput(t *testing.T) {
	in := `{"url":"https://a/login","username":"ana","password":"S3cr3t","nested":{"api_key":"k","Authorization":"Bearer x","ok":1},
	"list":[{"token":"t"},{"fine":"v"}],"cookie":"sid=1","note":"my password is not a key"}`
	out := string(MaskInput(json.RawMessage(in)))
	for _, leaked := range []string{"S3cr3t", `"k"`, "Bearer x", `"t"`, "sid=1"} {
		if contains(out, leaked) {
			t.Errorf("secret %q leaked: %s", leaked, out)
		}
	}
	for _, kept := range []string{"https://a/login", "ana", `"fine":"v"`, "my password is not a key"} {
		if !contains(out, kept) {
			t.Errorf("%q should be preserved: %s", kept, out)
		}
	}
}

func TestMaskInput_NonObjectsAndGarbage(t *testing.T) {
	if got := string(MaskInput(json.RawMessage(`"plain"`))); got != `"plain"` {
		t.Errorf("string = %s", got)
	}
	if got := string(MaskInput(json.RawMessage(`not json`))); got != `{}` {
		t.Errorf("invalid json must become {}: %s", got)
	}
	if got := string(MaskInput(nil)); got != `{}` {
		t.Errorf("nil must become {}: %s", got)
	}
}

func contains(s, sub string) bool { return len(sub) > 0 && indexOf(s, sub) >= 0 }

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
