package auth

import (
	"context"
	"testing"
)

func TestDevVerifier(t *testing.T) {
	v := DevVerifier{}
	id, err := v.Verify(context.Background(), "dev:ana@x.com")
	if err != nil || id.Email != "ana@x.com" || id.Subject != "dev:ana@x.com" {
		t.Errorf("got %+v, %v", id, err)
	}
	for _, bad := range []string{"", "ana@x.com", "dev:", "dev:no-at"} {
		if _, err := v.Verify(context.Background(), bad); err == nil {
			t.Errorf("token %q should be rejected", bad)
		}
	}
}
