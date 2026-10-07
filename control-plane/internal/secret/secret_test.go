package secret

import (
	"bytes"
	"encoding/base64"
	"testing"
)

func key32() string { return base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)) }

func TestNew_RejectsBadKeys(t *testing.T) {
	for _, k := range []string{"", "not-base64!!", base64.StdEncoding.EncodeToString([]byte("short"))} {
		if _, err := New(k); err == nil {
			t.Errorf("key %q should be rejected", k)
		}
	}
}

func TestSealOpen_RoundTrip(t *testing.T) {
	box, err := New(key32())
	if err != nil {
		t.Fatal(err)
	}
	plain := []byte(`{"user":"a","password":"s3cret"}`)
	sealed, err := box.Seal(plain)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, []byte("s3cret")) {
		t.Fatal("ciphertext leaks plaintext")
	}
	got, err := box.Open(sealed)
	if err != nil || !bytes.Equal(got, plain) {
		t.Fatalf("Open = %q, %v", got, err)
	}
}

func TestSeal_UsesFreshNonce(t *testing.T) {
	box, _ := New(key32())
	a, _ := box.Seal([]byte("x"))
	b, _ := box.Seal([]byte("x"))
	if bytes.Equal(a, b) {
		t.Fatal("two seals of the same plaintext must differ")
	}
}

func TestOpen_RejectsTamperedAndWrongKey(t *testing.T) {
	box, _ := New(key32())
	sealed, _ := box.Seal([]byte("data"))
	sealed[len(sealed)-1] ^= 1
	if _, err := box.Open(sealed); err == nil {
		t.Error("tampered ciphertext must fail")
	}
	if _, err := box.Open([]byte("tiny")); err == nil {
		t.Error("short ciphertext must fail")
	}
	other, _ := New(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32)))
	good, _ := box.Seal([]byte("data"))
	if _, err := other.Open(good); err == nil {
		t.Error("wrong key must fail")
	}
}
