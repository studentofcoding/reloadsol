package main

import "testing"

func TestValidateRequiredSecrets(t *testing.T) {
	if err := validateRequiredSecrets(&Config{}); err == nil {
		t.Fatal("empty TrendingSecret must be rejected")
	}
	if err := validateRequiredSecrets(nil); err == nil {
		t.Fatal("nil config must be rejected")
	}
	if err := validateRequiredSecrets(&Config{TrendingSecret: "x"}); err != nil {
		t.Fatalf("configured secret rejected: %v", err)
	}
}

func TestNoCommittedDefaultSecret(t *testing.T) {
	t.Setenv("TRENDING_TRACKER_SECRET", "")
	t.Setenv("TRIGGER_SECRET", "")
	t.Setenv("DLMM_MANAGE_SECRET", "")
	cs := NewCronService()
	if cs.config.TrendingSecret != "" || cs.config.TriggerSecret != "" || cs.config.DLMMSecret != "" {
		t.Fatalf("secrets must default to empty, got trending=%q trigger=%q dlmm=%q",
			cs.config.TrendingSecret, cs.config.TriggerSecret, cs.config.DLMMSecret)
	}
}
