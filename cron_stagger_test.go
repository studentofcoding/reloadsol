package main

import (
	"testing"
	"time"

	"github.com/robfig/cron/v3"
)

func testParser(t *testing.T, anchor time.Time, step time.Duration) *staggerParser {
	t.Helper()
	p := newStaggerParser(cron.NewParser(
		cron.Second|cron.Minute|cron.Hour|cron.Dom|cron.Month|cron.Dow|cron.Descriptor,
	), anchor)
	p.step = step
	return p
}

// A Schedule must be a pure function of t: robfig may consult it more than once, and a value
// that depends on call history can silently move or strand the timetable.
func TestShiftedEveryIsPure(t *testing.T) {
	anchor := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	p := testParser(t, anchor, 7*time.Second)
	schedule, err := p.Parse("@every 900s")
	if err != nil {
		t.Fatal(err)
	}

	at := anchor.Add(37 * time.Minute)
	first := schedule.Next(at)
	for i := 0; i < 3; i++ {
		if got := schedule.Next(at); !got.Equal(first) {
			t.Fatalf("Next(%s) call %d = %s, want %s — schedule is not pure", at, i, got, first)
		}
	}
}

// `@every N` means "one period after the anchor, then every period" — the stagger only shifts
// the phase, so the cadence and the first-run delay are unchanged.
func TestShiftedEveryKeepsTheAtEveryCadence(t *testing.T) {
	anchor := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	p := testParser(t, anchor, 7*time.Second)
	// Second parsed job => offset 7s.
	if _, err := p.Parse("@every 300s"); err != nil {
		t.Fatal(err)
	}
	schedule, err := p.Parse("@every 300s")
	if err != nil {
		t.Fatal(err)
	}

	first := schedule.Next(anchor)
	want := anchor.Add(300*time.Second + 7*time.Second)
	if !first.Equal(want) {
		t.Fatalf("first run = %s, want %s", first, want)
	}
	if next := schedule.Next(first); !next.Equal(first.Add(300 * time.Second)) {
		t.Fatalf("second run = %s, want %s", next, first.Add(300*time.Second))
	}
	// Just after the first run it must schedule a full period later, not come due again.
	if next := schedule.Next(first.Add(time.Millisecond)); !next.Equal(first.Add(300 * time.Second)) {
		t.Fatalf("after first run, next = %s, want %s", next, first.Add(300*time.Second))
	}
}

// Explicit cron specs are wall-clock anchored on purpose; shifting their first run would add an
// unintended early call (the daily digest would fire at startup instead of 00:00).
func TestExplicitSpecsAreUntouched(t *testing.T) {
	anchor := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	inner := cron.NewParser(cron.Second | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor)
	p := testParser(t, anchor, 7*time.Second)

	for _, spec := range []string{"0 */5 * * * *", "0 */2 * * * *", "0 0 0 * * *", "0 0 2 * * *"} {
		want, err := inner.Parse(spec)
		if err != nil {
			t.Fatal(err)
		}
		got, err := p.Parse(spec)
		if err != nil {
			t.Fatal(err)
		}
		if got.Next(anchor) != want.Next(anchor) {
			t.Fatalf("%q was shifted: %s, want %s", spec, got.Next(anchor), want.Next(anchor))
		}
	}
}

// The real registration set, with the production step: every job must land on its own instant.
// Before the stagger they all shared one, which is what made the mcap open/manage pair collide
// on the single `mcap_tracker_sim` lock.
func TestRegisteredSetGetsDistinctFirstRuns(t *testing.T) {
	anchor := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	p := testParser(t, anchor, staggerStep)

	// The @every jobs as registered in production (intervals from the service config).
	intervals := []int{
		900, 900, 15, // sltp, signals refresh, ohlc
		900, 900, 900, 900, 900, // signals sim, mcap open, mcap manage, gmgn sim, social sim
		900, 600, 600, 600, 300, 1800, 300, 600, // activity poll, digger, roster, radar, rollup, cleanup, wallet poll, report
		900, 900, 900, 900, 900, 900, // dlmm screen/sim/manage, rh clmm, rh lp, sol arb
	}
	seen := map[time.Time]string{}
	for i, seconds := range intervals {
		spec := everySpec(seconds)
		schedule, err := p.Parse(spec)
		if err != nil {
			t.Fatalf("Parse(%q) failed: %v", spec, err)
		}
		first := schedule.Next(anchor)
		if prev, dup := seen[first]; dup {
			t.Fatalf("job #%d (%s) first runs at %s, same instants as %s — jobs still collide",
				i, spec, first, prev)
		}
		seen[first] = spec

		// A job must also come due within its own period after the first run (no stranding).
		gap := first.Sub(anchor)
		if gap > time.Duration(seconds)*time.Second+time.Duration(len(intervals))*staggerStep {
			t.Fatalf("job #%d (%s) first run is %s after start", i, spec, gap)
		}
	}
}

// The concrete defect: open and manage shared a lock, so their grids must not intersect.
func TestMcapOpenAndManageNeverShareAnInstant(t *testing.T) {
	anchor := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	p := testParser(t, anchor, staggerStep)
	open, err := p.Parse(everySpec(900))
	if err != nil {
		t.Fatal(err)
	}
	manage, err := p.Parse(everySpec(900))
	if err != nil {
		t.Fatal(err)
	}

	openAt := map[int64]bool{}
	at := anchor
	for i := 0; i < 200; i++ {
		at = open.Next(at)
		openAt[at.Unix()] = true
	}
	at = anchor
	for i := 0; i < 12; i++ {
		at = manage.Next(at)
		if openAt[at.Unix()] {
			t.Fatalf("manage run at %s collides with an open run", at)
		}
	}
}
