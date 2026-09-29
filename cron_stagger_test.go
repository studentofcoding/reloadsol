package main

import (
	"testing"
	"time"

	"github.com/robfig/cron/v3"
)

const testStep = 7 * time.Second

func TestStaggeredScheduleOffsetsTheFirstRunOnly(t *testing.T) {
	inner := cron.Every(15 * time.Second)
	s := &staggeredSchedule{inner: inner, offset: 21 * time.Second}
	base := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)

	// First run is shifted by the offset, so jobs do not all start on the same instant.
	first := s.Next(base)
	if got := first.Sub(base); got != 21*time.Second {
		t.Fatalf("first Next = +%s, want +21s", got)
	}
	// Subsequent runs follow the wrapped schedule's own cadence.
	second := s.Next(first)
	if got := second.Sub(first); got != 15*time.Second {
		t.Fatalf("second Next = +%s after the first, want the inner 15s", got)
	}
}

func TestStaggerParserGivesEveryJobADistinctOffset(t *testing.T) {
	p := newStaggerParser(cron.NewParser(cron.Second | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor))
	base := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)

	// The real registration set: all of these were @every, so all shared one start instant.
	specs := []string{
		"@every 15s", "@every 15s", "@every 90s", "@every 120s", "@every 120s",
		"@every 120s", "@every 300s", "@every 300s", "@every 60s", "@every 60s",
	}
	seen := map[time.Duration]string{}
	for i, spec := range specs {
		schedule, err := p.Parse(spec)
		if err != nil {
			t.Fatalf("Parse(%q) failed: %v", spec, err)
		}
		offset := schedule.Next(base).Sub(base)
		if prev, dup := seen[offset]; dup {
			t.Fatalf("spec #%d (%s) shares offset %s with %s — jobs would still collide", i, spec, offset, prev)
		}
		seen[offset] = spec
	}
	if len(seen) != len(specs) {
		t.Fatalf("got %d distinct offsets for %d specs", len(seen), len(specs))
	}
}

// Explicit cron specs are wall-clock anchored on purpose — shifting their first run would add
// an unintended early call (the daily digest would fire at startup, not at 00:00).
func TestStaggerParserLeavesExplicitSpecsAlone(t *testing.T) {
	inner := cron.NewParser(cron.Second | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor)
	p := newStaggerParser(inner)
	base := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)

	for _, spec := range []string{"0 */5 * * * *", "0 0 0 * * *", "0 0 2 * * *"} {
		want, err := inner.Parse(spec)
		if err != nil {
			t.Fatal(err)
		}
		got, err := p.Parse(spec)
		if err != nil {
			t.Fatal(err)
		}
		if got.Next(base) != want.Next(base) {
			t.Fatalf("%q was shifted: got %s, want %s", spec, got.Next(base), want.Next(base))
		}
	}
}

// The concrete defect: open (every 15s) and manage (every 120s) shared one job lock, so on
// every 120s boundary one lost the race. Their grids must not intersect.
func TestStaggeredJobsDoNotStartOnTheSameInstant(t *testing.T) {
	p := newStaggerParser(cron.NewParser(cron.Second | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor))
	base := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)

	open, err := p.Parse("@every 15s")
	if err != nil {
		t.Fatal(err)
	}
	manage, err := p.Parse("@every 120s")
	if err != nil {
		t.Fatal(err)
	}

	openAt := map[int64]bool{}
	at := base
	for i := 0; i < 60; i++ {
		at = open.Next(at)
		openAt[at.Unix()] = true
	}
	at = base
	for i := 0; i < 8; i++ {
		at = manage.Next(at)
		if openAt[at.Unix()] {
			t.Fatalf("manage run at %s collides with an open run", at)
		}
	}
}
