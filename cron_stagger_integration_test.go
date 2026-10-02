package main

import (
	"sync"
	"testing"
	"time"

	"github.com/robfig/cron/v3"
)

// End-to-end against the REAL cron: every staggered job must actually fire, and no two may fire
// on the same instant. This is the check that the previous (stateful) draft could not have
// passed honestly — it was never run against a live cron before shipping.
func TestStaggeredJobsFireSeparatelyUnderRealCron(t *testing.T) {
	anchor := time.Now()
	p := newStaggerParser(cron.NewParser(
		cron.Second|cron.Minute|cron.Hour|cron.Dom|cron.Month|cron.Dow|cron.Descriptor,
	), anchor)
	p.step = 300 * time.Millisecond
	c := cron.New(cron.WithParser(p))

	var mu sync.Mutex
	fired := map[string]time.Time{}
	const jobs = 3

	start := time.Now()
	for _, name := range []string{"a", "b", "c"} {
		jobName := name
		// 2s period: first run is at ~2.0s, 2.3s, 2.6s with the 300ms step.
		if _, err := c.AddFunc("@every 2s", func() {
			mu.Lock()
			defer mu.Unlock()
			if _, seen := fired[jobName]; !seen {
				fired[jobName] = time.Now()
			}
		}); err != nil {
			t.Fatalf("AddFunc failed: %v", err)
		}
	}
	c.Start()
	defer c.Stop()

	deadline := time.After(6 * time.Second)
	for {
		mu.Lock()
		n := len(fired)
		mu.Unlock()
		if n == jobs {
			break
		}
		select {
		case <-deadline:
			mu.Lock()
			got := map[string]time.Time{}
			for k, v := range fired {
				got[k] = v
			}
			mu.Unlock()
			t.Fatalf("only %d/%d jobs fired within 6s (2s period): %v", n, jobs, got)
		case <-time.After(25 * time.Millisecond):
		}
	}

	mu.Lock()
	defer mu.Unlock()
	instants := map[int64]string{}
	for name, at := range fired {
		// Distinct milliseconds: the whole point is that they do not pile up.
		key := at.UnixMilli()
		if prev, dup := instants[key]; dup {
			t.Fatalf("job %s fired at %s — same instant as %s", name, at, prev)
		}
		instants[key] = name
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("jobs took %s to fire, expected about one period", elapsed)
	}
}
