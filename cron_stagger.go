package main

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/robfig/cron/v3"
)

// everySpec builds a job's `@every Ns` spec. Registration and the stagger tests both go
// through it, so the spec format cannot drift between them.
func everySpec(intervalSeconds int) string {
	return fmt.Sprintf("@every %ds", intervalSeconds)
}

// Every job in this service is registered as `@every Ns`, and robfig/cron's
// ConstantDelaySchedule is relative to process start — so all of them fired on the same
// instant and then coexisted on their period grids. Measured consequence: the mcap sim's open
// and manage phases (both every 900s here) share the single `mcap_tracker_sim` job lock, so
// on every 15-minute tick one of them lost the race and answered 409 — logged live as
// `⏭️ MCap tracker sim manage skipped (job lock held)`.
//
// staggerParser shifts each `@every` job's grid by a distinct offset (15s steps, in
// registration order). 15s is deliberate: it is ~10x the normal duration of the phases that
// share a lock (the mcap open/manage pair runs 1-2s normally), so the loser of a race has room
// to finish before the other starts — while ~22 jobs still spread over only ~5 minutes, so a
// restart does not push the last job far into its period.
//
// shiftedEvery is a PURE function of its arguments — `Next(t)` depends only on t, the
// captured anchor, the offset and the period. That matters: robfig's loop decides how long to
// sleep from the earliest entry's Next (`if c.entries[0].Next.IsZero() { timer = 100000*time.Hour }`),
// and it may consult a Schedule from more than one place, so a schedule that carries call
// history (an earlier draft used a `first` flag) can silently change or strand the timetable.
const staggerStep = 15 * time.Second

// shiftedEvery reproduces `@every period` — first run one period after the anchor, then every
// period — shifted by `offset` so that no two jobs share an instant.
type shiftedEvery struct {
	anchor time.Time
	offset time.Duration
	period time.Duration
}

func (s *shiftedEvery) Next(t time.Time) time.Time {
	first := s.anchor.Add(s.offset + s.period)
	// Strictly before: the first run has not happened yet.
	if t.Before(first) {
		return first
	}
	// At or after: advance to the next instant strictly after t. Returning `first` when t equals
	// it would leave robfig with a Next that is never ahead of now, and it would re-run the job
	// on every loop iteration.
	steps := int64(t.Sub(first)/s.period) + 1
	return first.Add(time.Duration(steps) * s.period)
}

type staggerParser struct {
	inner  cron.ScheduleParser
	anchor time.Time
	// step is staggerStep in production; overridable so tests can drive the real cron fast.
	step time.Duration
	mu   sync.Mutex
	n    int
}

func newStaggerParser(inner cron.ScheduleParser, anchor time.Time) *staggerParser {
	return &staggerParser{inner: inner, anchor: anchor, step: staggerStep}
}

func (p *staggerParser) Parse(spec string) (cron.Schedule, error) {
	schedule, err := p.inner.Parse(spec)
	if err != nil {
		return nil, err
	}
	// Only `@every` specs pile up on the process-start instant. Explicit cron specs are
	// wall-clock anchored on purpose — the daily digest must stay at 00:00, the PnL update at
	// 02:00 — so they are returned untouched.
	if !strings.HasPrefix(spec, "@every ") {
		return schedule, nil
	}
	period, err := time.ParseDuration(strings.TrimPrefix(spec, "@every "))
	if err != nil || period <= 0 {
		return schedule, nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	offset := time.Duration(p.n) * p.step
	p.n++
	return &shiftedEvery{anchor: p.anchor, offset: offset, period: period}, nil
}

// newStaggeredCron builds the service cron: second-resolution specs (so the six-field specs in
// use keep working) with the stagger applied to `@every` jobs.
func newStaggeredCron() *cron.Cron {
	return cron.New(cron.WithParser(newStaggerParser(cron.NewParser(
		// Descriptor is required: `@every Ns` is a descriptor, and without this bit the
		// parser rejects every spec the service uses.
		cron.Second|cron.Minute|cron.Hour|cron.Dom|cron.Month|cron.Dow|cron.Descriptor,
	), time.Now())))
}
