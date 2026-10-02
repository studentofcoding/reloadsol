package main

import "testing"

func TestIsSkippedBody(t *testing.T) {
	cases := []struct {
		name string
		body string
		want bool
	}{
		{"withJobLock 409 body", `{"success":false,"skipped":true,"reason":"Job \"mcap_tracker_sim\" already running"}`, true},
		{"skipped false", `{"success":true,"skipped":false}`, false},
		{"real payload", `{"success":true,"phase":"manage","results":[{"strategyId":"mcap_enter_at_80","opened":0}]}`, false},
		{"not json", `Internal Server Error`, false},
		{"empty", ``, false},
		{"json without the key", `{"success":true}`, false},
		{"skipped as a string, not a bool", `{"success":false,"skipped":"true"}`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isSkippedBody(tc.body); got != tc.want {
				t.Fatalf("isSkippedBody(%q) = %v, want %v", tc.body, got, tc.want)
			}
		})
	}
}
