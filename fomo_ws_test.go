package main

import (
	"encoding/json"
	"testing"
)

func TestFillID(t *testing.T) {
	if fillID(json.RawMessage(`{"id":99,"tx":"0x"}`)) != 99 {
		t.Fatal("expected id 99")
	}
	if fillID(json.RawMessage(`{"tx":"0x"}`)) != 0 {
		t.Fatal("missing id should be 0")
	}
}

func TestParseTapeFills(t *testing.T) {
	arr := parseTapeFills([]byte(`[{"id":1},{"id":2}]`))
	if len(arr) != 2 {
		t.Fatalf("got %d", len(arr))
	}
	wrapped := parseTapeFills([]byte(`{"data":[{"id":3}]}`))
	if len(wrapped) != 1 || fillID(wrapped[0]) != 3 {
		t.Fatalf("wrap: %v", wrapped)
	}
}
