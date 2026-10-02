package main

import (
	"strings"
	"testing"
)

func TestRedactSecretsStripsCredentialQueryParams(t *testing.T) {
	in := "Post \"http://web:3000/api/signals/sim-track?key=r3l0ads0l-trending&phase=open\": EOF"
	out := redactSecrets(in)
	if strings.Contains(out, "r3l0ads0l-trending") {
		t.Fatalf("secret survived redaction: %s", out)
	}
	if !strings.Contains(out, "key=REDACTED&phase=open") {
		t.Fatalf("redaction must keep the rest of the URL readable: %s", out)
	}
}

func TestRedactSecretsLeavesPlainURLsAlone(t *testing.T) {
	in := "http://web:3000/api/sl-tp-monitor"
	if got := redactSecrets(in); got != in {
		t.Fatalf("unexpected change: %s", got)
	}
}
