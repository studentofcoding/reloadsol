package main

import (
	"fmt"
	"log"
	"os"
	"sort"
	"strconv"
	"strings"
)

// The single table of every interval-driven job: its Config field, the env var that tunes it, and the
// code default that is *intended* when nothing is set.
//
// Why this exists. On the production VPS a dozen jobs were all reporting `interval_sec: 900`. The Go
// code has exactly one 900 default (the 1m metrics copier, intentionally). The other eleven came from
// `.env` — a contiguous, uncommented block of `*_INTERVAL=900` lines added between 2026-09-23 and
// 2026-09-25 (see the dated `.env.bak-*` files), i.e. a manual load-shed that nothing in the service
// ever surfaced: the parse loops below swallowed bad values silently, and an override that disagreed
// with the intended cadence logged nothing. The fix is not to hard-code the number back — an operator
// must be able to slow a job down — but to make every deviation from the intended cadence loud, and to
// keep the intended cadence in one place that a test pins.
//
// Adding a Config field named `*Interval` without a row here fails TestEveryIntervalFieldHasASpec, so a
// new job cannot quietly acquire a default.
type intervalSpec struct {
	Field     string   // Config field
	Env       string   // env var that overrides it
	Default   int      // intended cadence in seconds when Env is unset
	AllowZero bool     // 0 disables the job
	Workers   []string // worker ids whose registry row reports this interval
	// MaxSane, when > 0, is a ceiling above which the override is logged as an ERROR, not a warning:
	// the job's purpose fails if it runs that rarely (the sole position closer at 900s left positions
	// unmanaged past their stops — it ran at 900s until 2026-10-02).
	MaxSane int
	// Scheduled is false for a knob that no longer drives its own cron entry.
	Scheduled bool
}

var intervalSpecs = []intervalSpec{
	{Field: "SLTPMonitorInterval", Env: "SLTP_MONITOR_INTERVAL", Default: 60, Workers: []string{"sltp_monitor"}, MaxSane: 300, Scheduled: true},
	{Field: "SignalRefreshInterval", Env: "SIGNAL_REFRESH_INTERVAL", Default: 60, Workers: []string{"signals_refresh"}, Scheduled: true},
	{Field: "SignalsSimInterval", Env: "SIGNALS_SIM_INTERVAL", Default: 120, Workers: []string{"signals_sim_track"}, Scheduled: true},
	{Field: "McapTrackerSimInterval", Env: "MCAP_TRACKER_SIM_INTERVAL", Default: 120, Workers: []string{"mcap_tracker_sim_track", "mcap_tracker_sim_open"}, Scheduled: true},
	// The open phase runs inside the phase=all job at McapTrackerSimInterval; this knob schedules nothing.
	{Field: "McapTrackerSimOpenInterval", Env: "MCAP_TRACKER_SIM_OPEN_INTERVAL", Default: 15},
	{Field: "GmgnSimInterval", Env: "GMGN_SIM_INTERVAL", Default: 120, Workers: []string{"gmgn_sim_track"}, Scheduled: true},
	{Field: "SocialSimInterval", Env: "SOCIAL_SIM_INTERVAL", Default: 90, Workers: []string{"social_sim_track"}, Scheduled: true},
	{Field: "GmgnActivityPollInterval", Env: "GMGN_ACTIVITY_POLL_INTERVAL", Default: 180, Workers: []string{"gmgn_activity_poll"}, Scheduled: true},
	{Field: "GmgnRadarDigestInterval", Env: "GMGN_RADAR_DIGEST_INTERVAL", Default: 86400, AllowZero: true, Workers: []string{"gmgn_radar_digest"}, Scheduled: true},
	{Field: "GmgnWalletDiggerInterval", Env: "GMGN_WALLET_DIGGER_INTERVAL", Default: 14400, AllowZero: true, Workers: []string{"gmgn_wallet_digger"}, Scheduled: true},
	{Field: "GmgnRosterWatchInterval", Env: "GMGN_ROSTER_WATCH_INTERVAL", Default: 75, AllowZero: true, Workers: []string{"gmgn_roster_watch"}, Scheduled: true},
	{Field: "StrategyReportInterval", Env: "STRATEGY_REPORT_INTERVAL", Default: 86400, AllowZero: true, Workers: []string{"strategy_report"}, Scheduled: true},
	{Field: "ReportPrecomputeInterval", Env: "REPORT_PRECOMPUTE_INTERVAL", Default: 21600, AllowZero: true, Workers: []string{"report_precompute"}, Scheduled: true},
	{Field: "DLMMScreenInterval", Env: "DLMM_SCREEN_INTERVAL", Default: 300, Workers: []string{"dlmm_screen"}, Scheduled: true},
	{Field: "DLMMSimTrackInterval", Env: "DLMM_SIM_TRACK_INTERVAL", Default: 300, Workers: []string{"dlmm_sim_track"}, Scheduled: true},
	{Field: "DLMMManageInterval", Env: "DLMM_MANAGE_INTERVAL", Default: 60, Workers: []string{"dlmm_manage"}, Scheduled: true},
	{Field: "RhClmmManageInterval", Env: "RH_CLMM_MANAGE_INTERVAL", Default: 300, Workers: []string{"rh_clmm_manage"}, Scheduled: true},
	{Field: "RhLpScreenInterval", Env: "RH_LP_SCREEN_INTERVAL", Default: 300, AllowZero: true, Workers: []string{"rh_lp_screen"}, Scheduled: true},
	{Field: "StrategySearchInterval", Env: "STRATEGY_SEARCH_INTERVAL", Default: 21600, AllowZero: true, Workers: []string{"strategy_search"}, Scheduled: true},
	{Field: "SolArbScanInterval", Env: "SOL_ARB_SCAN_INTERVAL", Default: 60, AllowZero: true, Workers: []string{"sol_arb_scan"}, Scheduled: true},
	// 15s ticks give 4 samples per minute, which is what makes a real intra-minute high/low possible.
	{Field: "OhlcSampleInterval", Env: "OHLC_SAMPLE_INTERVAL", Default: 15, AllowZero: true, Workers: []string{"ohlc_sampler"}, Scheduled: true},
	// The one intentional 900: GMGN's candle endpoint returns a SERIES (~8.35h of minutes per call), so the
	// cadence governs snapshot freshness only. Keep it well under that window or the gap loses minutes.
	{Field: "MetricsCopyInterval", Env: "METRICS_COPY_INTERVAL", Default: 900, AllowZero: true, Workers: []string{"metrics_copier"}, Scheduled: true},
}

// intervalResolution is how one knob resolved, kept so the service can say so at startup.
type intervalResolution struct {
	Spec    intervalSpec
	Seconds int
	// Source: "default" (env unset), "env" (valid override), "invalid" (env set but unusable → default).
	Source string
	Raw    string
}

func intervalSpecFor(field string) intervalSpec {
	for _, s := range intervalSpecs {
		if s.Field == field {
			return s
		}
	}
	// Programmer error, not an operator one: a Config interval with no row has no intended default.
	panic("cron: no intervalSpec for Config." + field)
}

// resolveInterval applies one spec to an env lookup. Pure, so the table test can drive it.
func resolveInterval(s intervalSpec, lookup func(string) string) intervalResolution {
	raw := strings.TrimSpace(lookup(s.Env))
	if raw == "" {
		return intervalResolution{Spec: s, Seconds: s.Default, Source: "default"}
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 || (n == 0 && !s.AllowZero) {
		// Used to fall back silently to the default; the operator believed they had set something.
		return intervalResolution{Spec: s, Seconds: s.Default, Source: "invalid", Raw: raw}
	}
	return intervalResolution{Spec: s, Seconds: n, Source: "env", Raw: raw}
}

// intervalMessages is every line worth an operator's attention about one resolution (none when it is
// simply the default). Returned rather than logged so the test can assert on them.
func (r intervalResolution) messages() (level string, msgs []string) {
	s := r.Spec
	switch r.Source {
	case "invalid":
		return "ERROR", []string{fmt.Sprintf("%s=%q is not a usable interval (want a whole number of seconds%s) — IGNORED, using the default %ds for %s",
			s.Env, r.Raw, map[bool]string{true: ", 0 disables", false: " > 0"}[s.AllowZero], s.Default, s.Field)}
	case "env":
		if r.Seconds == s.Default {
			return "", nil
		}
		if r.Seconds == 0 {
			return "WARN", []string{fmt.Sprintf("%s=0 disables %s (default %ds)", s.Env, strings.Join(s.Workers, ","), s.Default)}
		}
		if s.MaxSane > 0 && r.Seconds > s.MaxSane {
			return "ERROR", []string{fmt.Sprintf("%s=%d is above the sane ceiling %ds for %s (default %ds) — it will not do its job at this cadence",
				s.Env, r.Seconds, s.MaxSane, strings.Join(s.Workers, ","), s.Default)}
		}
		return "WARN", []string{fmt.Sprintf("%s=%d overrides the default %ds for %s", s.Env, r.Seconds, s.Default, strings.Join(s.Workers, ","))}
	}
	return "", nil
}

// intervalResolutions records every resolution made by NewCronService, for the startup audit.
var intervalResolutions []intervalResolution

// intervalFor resolves a Config interval from the environment and logs anything unusual about it.
func intervalFor(field string) int {
	r := resolveInterval(intervalSpecFor(field), os.Getenv)
	intervalResolutions = append(intervalResolutions, r)
	if level, msgs := r.messages(); level != "" {
		for _, m := range msgs {
			log.Printf("[cron-intervals] %s: %s", level, m)
		}
	}
	return r.Seconds
}

// intervalAuditSummary renders the effective cadence of every knob, flagging each deviation from the
// intended default. One block, emitted at startup, so "why is X every 900s" is answerable from the
// service's own log instead of from a shell on the host.
func intervalAuditSummary(rs []intervalResolution) (summary string, deviations int) {
	rows := append([]intervalResolution(nil), rs...)
	sort.Slice(rows, func(i, j int) bool { return rows[i].Spec.Env < rows[j].Spec.Env })
	var b strings.Builder
	b.WriteString("cron intervals (effective / default):")
	for _, r := range rows {
		flag := ""
		if level, _ := r.messages(); level != "" {
			flag = "  <-- " + level
			deviations++
		}
		fmt.Fprintf(&b, "\n  %-32s %6ds / %6ds  [%s]%s", r.Spec.Env, r.Seconds, r.Spec.Default, r.Source, flag)
	}
	return b.String(), deviations
}

// auditIntervals logs the startup summary. Deviations go to the Discord logger at warning level so a
// blanket throttle in `.env` is visible without anyone having to look.
func (cs *CronService) auditIntervals() {
	summary, deviations := intervalAuditSummary(intervalResolutions)
	log.Print(summary)
	if deviations > 0 {
		cs.logger.Warning(fmt.Sprintf("⏱️ %d cron interval(s) differ from the code default — %s", deviations, summary))
	}
}
