package main

import (
	"strings"
	"sync"
	"time"

	"github.com/robfig/cron/v3"
)

// Every job in this service was registered as `@every Ns`, and robfig/cron starts a
// ConstantDelaySchedule at process start — so all ~25 jobs fired on the same wall-clock
// instant and then coexisted on their period grids. That matters because two of them must
// NOT run at once by design: the mcap sim's open path (every 15s by default) and its
// manage path (every 120s) share the single `mcp_tracker_sim` job lock, so on every 120s
// boundary one of them lost the race and answered 409 — the sim ran at half its intended
// frequency, and the loser was reported as a success until workers.Skipped landed.
//
// staggerParser shifts each registered job's FIRST run by a distinct offset (7s steps, in
// registration order) so the pile-up cannot happen. 7s is deliberate: the smallest period
// here is 15s, and distinct multiples of 7 cover every residue mod 15, so no two 15s jobs
// share an instant. Offsets are deterministic (not random) so a restart reproduces them.
const staggerStep = 7 * time.Second

type staggeredSchedule struct {
	inner  cron.Schedule
	offset time.Duration
	first  bool
}

// Next returns the offset instant for the first run, then follows the wrapped schedule.
func (s *staggeredSchedule) Next(t time.Time) time.Time {
	if !s.first {
		s.first = true
		return t.Add(s.offset)
	}
	return s.inner.Next(t)
}

type staggerParser struct {
	inner cron.ScheduleParser
	mu    sync.Mutex
	n     int
}

func newStaggerParser(inner cron.ScheduleParser) *staggerParser {
	return &staggerParser{inner: inner}
}

func (p *staggerParser) Parse(spec string) (cron.Schedule, error) {
	schedule, err := p.inner.Parse(spec)
	if err != nil {
		return nil, err
	}
	// Only `@every` specs pile up on the process-start instant. Explicit cron specs are
	// wall-clock anchored on purpose — a daily digest must stay at 00:00 and the PnL update
	// at 02:00 — so shifting their first run would add an unintended early call.
	if !strings.HasPrefix(spec, "@") {
		return schedule, nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	offset := time.Duration(p.n) * staggerStep
	p.n++
	return &staggeredSchedule{inner: schedule, offset: offset}, nil
}
