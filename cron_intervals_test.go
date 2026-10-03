package main

import (
	"bytes"
	"log"
	"os"
	"reflect"
	"strings"
	"testing"
)

// The intended cadence of every interval-driven job, written out independently of the code under test.
// A change to a default in cron_intervals.go must be mirrored here on purpose.
//
// `current` is what production's .env sets today (read-only from the VPS on 2026-10-03) and is listed
// so the gap is reviewable; it is NOT asserted. Rows marked ambiguous keep their current value and are
// called out in the PR.
type intendedInterval struct {
	field    string
	env      string
	workers  []string
	intended int
	current  int  // prod .env value; 0 = unset in prod (default in force)
	disabled bool // true if the default means "off"
}

var intendedIntervals = []intendedInterval{
	{"SLTPMonitorInterval", "SLTP_MONITOR_INTERVAL", []string{"sltp_monitor"}, 60, 60, false},
	{"SignalRefreshInterval", "SIGNAL_REFRESH_INTERVAL", []string{"signals_refresh"}, 60, 900, false},
	{"SignalsSimInterval", "SIGNALS_SIM_INTERVAL", []string{"signals_sim_track"}, 120, 900, false},
	{"McapTrackerSimInterval", "MCAP_TRACKER_SIM_INTERVAL", []string{"mcap_tracker_sim_track"}, 120, 120, false},
	{"GmgnSimInterval", "GMGN_SIM_INTERVAL", []string{"gmgn_sim_track"}, 120, 900, false},
	{"SocialSimInterval", "SOCIAL_SIM_INTERVAL", []string{"social_sim_track"}, 90, 900, false}, // AMBIGUOUS: docs say 900 on prod is intended
	{"GmgnActivityPollInterval", "GMGN_ACTIVITY_POLL_INTERVAL", []string{"gmgn_activity_poll"}, 180, 900, false},
	{"GmgnRadarDigestInterval", "GMGN_RADAR_DIGEST_INTERVAL", []string{"gmgn_radar_digest"}, 86400, 600, false},
	{"GmgnWalletDiggerInterval", "GMGN_WALLET_DIGGER_INTERVAL", []string{"gmgn_wallet_digger"}, 14400, 600, false},
	{"StrategyReportInterval", "STRATEGY_REPORT_INTERVAL", []string{"strategy_report"}, 86400, 86400, false},
	{"ReportPrecomputeInterval", "REPORT_PRECOMPUTE_INTERVAL", []string{"report_precompute"}, 21600, 21600, false},
	{"DLMMScreenInterval", "DLMM_SCREEN_INTERVAL", []string{"dlmm_screen"}, 300, 300, false},
	{"DLMMSimTrackInterval", "DLMM_SIM_TRACK_INTERVAL", []string{"dlmm_sim_track"}, 300, 900, false},
	{"DLMMManageInterval", "DLMM_MANAGE_INTERVAL", []string{"dlmm_manage"}, 60, 900, false},
	{"RhClmmManageInterval", "RH_CLMM_MANAGE_INTERVAL", []string{"rh_clmm_manage"}, 300, 900, false},
	{"StrategySearchInterval", "STRATEGY_SEARCH_INTERVAL", []string{"strategy_search"}, 21600, 600, false},
	{"SolArbScanInterval", "SOL_ARB_SCAN_INTERVAL", []string{"sol_arb_scan"}, 60, 900, false},
	{"OhlcSampleInterval", "OHLC_SAMPLE_INTERVAL", []string{"ohlc_sampler"}, 15, 15, false},
	{"MetricsCopyInterval", "METRICS_COPY_INTERVAL", []string{"metrics_copier"}, 900, 900, false}, // the one intentional 900
}

// clearIntervalEnv unsets every interval env var for the test and restores it afterwards.
func clearIntervalEnv(t *testing.T) {
	t.Helper()
	for _, s := range intervalSpecs {
		if old, ok := os.LookupEnv(s.Env); ok {
			t.Cleanup(func() { os.Setenv(s.Env, old) })
		} else {
			t.Cleanup(func() { os.Unsetenv(s.Env) })
		}
		os.Unsetenv(s.Env)
	}
}

func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prevW, prevF := log.Writer(), log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	t.Cleanup(func() { log.SetOutput(prevW); log.SetFlags(prevF) })
	return &buf
}

func workerIntervals(cs *CronService) map[string]int {
	cs.initWorkerRegistry()
	out := map[string]int{}
	for _, row := range cs.workers.Snapshot() {
		out[row["id"].(string)] = row["interval_sec"].(int)
	}
	return out
}

// The registered interval of every job, with nothing set in the environment, is the intended one.
func TestRegisteredIntervalsMatchTheIntendedTableByDefault(t *testing.T) {
	clearIntervalEnv(t)
	captureLog(t)
	got := workerIntervals(NewCronService())

	for _, want := range intendedIntervals {
		for _, w := range want.workers {
			if got[w] != want.intended {
				t.Errorf("worker %s: registered interval = %ds, intended %ds (%s)", w, got[w], want.intended, want.env)
			}
		}
	}
	// Jobs with a fixed (non-env) cadence are pinned too, so a stray edit shows up here.
	fixed := map[string]int{
		"social_rollup": 300, "social_cleanup": 1800, "social_wallet_poll": 300, "trending_tracker": 300,
		"unfiltered_trending": 120, "daily_summary": 86400, "pnl_update": 86400,
	}
	for id, want := range fixed {
		if got[id] != want {
			t.Errorf("fixed-cadence worker %s: interval = %ds, want %ds", id, got[id], want)
		}
	}
}

// No default may be 900 except the metrics copier's — the symptom that started this.
func TestOnlyTheMetricsCopierDefaultsTo900(t *testing.T) {
	for _, s := range intervalSpecs {
		if s.Default == 900 && s.Env != "METRICS_COPY_INTERVAL" {
			t.Errorf("%s defaults to 900s; only METRICS_COPY_INTERVAL does so intentionally", s.Env)
		}
	}
}

// The code's defaults and the test's table must be the same set — neither side may gain a job alone.
func TestSpecTableAndIntendedTableAgree(t *testing.T) {
	byField := map[string]intervalSpec{}
	for _, s := range intervalSpecs {
		byField[s.Field] = s
	}
	seen := map[string]bool{}
	for _, want := range intendedIntervals {
		s, ok := byField[want.field]
		if !ok {
			t.Errorf("%s is in the intended table but has no intervalSpec", want.field)
			continue
		}
		seen[want.field] = true
		if s.Env != want.env || s.Default != want.intended {
			t.Errorf("%s: spec = %s/%ds, intended table = %s/%ds", want.field, s.Env, s.Default, want.env, want.intended)
		}
		if strings.Join(s.Workers, ",") != strings.Join(want.workers, ",") {
			t.Errorf("%s: spec workers %v != intended %v", want.field, s.Workers, want.workers)
		}
	}
	for _, s := range intervalSpecs {
		if !seen[s.Field] {
			t.Errorf("%s has an intervalSpec but no row in the intended table", s.Field)
		}
	}
}

// A new `*Interval` Config field cannot be added without a spec — i.e. without an intended default.
func TestEveryIntervalFieldHasASpec(t *testing.T) {
	have := map[string]bool{}
	for _, s := range intervalSpecs {
		have[s.Field] = true
	}
	typ := reflect.TypeOf(Config{})
	for i := 0; i < typ.NumField(); i++ {
		name := typ.Field(i).Name
		if strings.HasSuffix(name, "Interval") && !have[name] {
			t.Errorf("Config.%s has no intervalSpec — it would have no intended default", name)
		}
	}
	for _, s := range intervalSpecs {
		if _, ok := typ.FieldByName(s.Field); !ok {
			t.Errorf("intervalSpec %s names a Config field that does not exist", s.Field)
		}
	}
}

// An env override is honoured, and is loud.
func TestOverrideIsAppliedAndLogged(t *testing.T) {
	clearIntervalEnv(t)
	buf := captureLog(t)
	t.Setenv("SIGNAL_REFRESH_INTERVAL", "900")
	t.Setenv("DLMM_MANAGE_INTERVAL", "30")

	cs := NewCronService()
	if cs.config.SignalRefreshInterval != 900 || cs.config.DLMMManageInterval != 30 {
		t.Fatalf("overrides not applied: %d, %d", cs.config.SignalRefreshInterval, cs.config.DLMMManageInterval)
	}
	out := buf.String()
	for _, want := range []string{
		"SIGNAL_REFRESH_INTERVAL=900 overrides the default 60s for signals_refresh",
		"DLMM_MANAGE_INTERVAL=30 overrides the default 60s for dlmm_manage",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("log missing %q\n%s", want, out)
		}
	}
	// A value equal to the default is not noise.
	if strings.Contains(out, "SLTP_MONITOR_INTERVAL") {
		t.Errorf("an unset knob must not be logged:\n%s", out)
	}
}

func TestOverrideEqualToTheDefaultIsQuiet(t *testing.T) {
	clearIntervalEnv(t)
	buf := captureLog(t)
	t.Setenv("SLTP_MONITOR_INTERVAL", "60")
	if got := NewCronService().config.SLTPMonitorInterval; got != 60 {
		t.Fatalf("got %d", got)
	}
	if strings.Contains(buf.String(), "SLTP_MONITOR_INTERVAL") {
		t.Errorf("an override equal to the default must not warn:\n%s", buf.String())
	}
}

// The silent fallback is gone: unusable values are rejected LOUDLY and the default is used.
func TestInvalidValuesFallBackToTheDefaultLoudly(t *testing.T) {
	for _, tc := range []struct{ env, val string }{
		{"GMGN_SIM_INTERVAL", "abc"},
		{"GMGN_SIM_INTERVAL", "-5"},
		{"GMGN_SIM_INTERVAL", "0"}, // 0 does not disable a job that cannot be disabled
		{"GMGN_SIM_INTERVAL", "1.5"},
		{"OHLC_SAMPLE_INTERVAL", "-1"},
	} {
		t.Run(tc.env+"="+tc.val, func(t *testing.T) {
			clearIntervalEnv(t)
			buf := captureLog(t)
			t.Setenv(tc.env, tc.val)
			cs := NewCronService()
			var spec intervalSpec
			for _, s := range intervalSpecs {
				if s.Env == tc.env {
					spec = s
				}
			}
			got := reflect.ValueOf(*cs.config).FieldByName(spec.Field).Int()
			if int(got) != spec.Default {
				t.Errorf("%s=%q resolved to %d, want the default %d", tc.env, tc.val, got, spec.Default)
			}
			if !strings.Contains(buf.String(), "ERROR") || !strings.Contains(buf.String(), tc.env) || !strings.Contains(buf.String(), "IGNORED") {
				t.Errorf("an invalid %s=%q must be logged as an ERROR:\n%s", tc.env, tc.val, buf.String())
			}
		})
	}
}

func TestZeroDisablesOnlyWhereAllowed(t *testing.T) {
	clearIntervalEnv(t)
	captureLog(t)
	t.Setenv("OHLC_SAMPLE_INTERVAL", "0")
	t.Setenv("METRICS_COPY_INTERVAL", "0")
	cs := NewCronService()
	if cs.config.OhlcSampleInterval != 0 || cs.config.MetricsCopyInterval != 0 {
		t.Fatalf("0 must disable jobs that allow it: %d %d", cs.config.OhlcSampleInterval, cs.config.MetricsCopyInterval)
	}
	cs.initWorkerRegistry()
	for _, row := range cs.workers.Snapshot() {
		if (row["id"] == "ohlc_sampler" || row["id"] == "metrics_copier") && row["disabled"] != true {
			t.Errorf("%v should report disabled", row["id"])
		}
	}
}

// The sole position closer at 900s is an error, not a preference (it ran at 900s until 2026-10-02).
func TestSLTPMonitorAboveTheCeilingIsAnError(t *testing.T) {
	clearIntervalEnv(t)
	buf := captureLog(t)
	t.Setenv("SLTP_MONITOR_INTERVAL", "900")
	if got := NewCronService().config.SLTPMonitorInterval; got != 900 {
		t.Fatalf("an operator override is still honoured, got %d", got)
	}
	out := buf.String()
	if !strings.Contains(out, "ERROR") || !strings.Contains(out, "above the sane ceiling 300s") {
		t.Errorf("SLTP_MONITOR_INTERVAL=900 must be logged as an ERROR:\n%s", out)
	}
}

// The startup summary names every deviation, so "why is X 900s" is answerable from the service log.
func TestAuditSummaryFlagsEveryDeviation(t *testing.T) {
	clearIntervalEnv(t)
	captureLog(t)
	t.Setenv("SOL_ARB_SCAN_INTERVAL", "900")
	t.Setenv("RH_CLMM_MANAGE_INTERVAL", "900")
	NewCronService()
	summary, deviations := intervalAuditSummary(intervalResolutions)
	if deviations != 2 {
		t.Fatalf("deviations = %d, want 2\n%s", deviations, summary)
	}
	for _, env := range []string{"SOL_ARB_SCAN_INTERVAL", "RH_CLMM_MANAGE_INTERVAL"} {
		line := ""
		for _, l := range strings.Split(summary, "\n") {
			if strings.Contains(l, env) {
				line = l
			}
		}
		if !strings.Contains(line, "900s") || !strings.Contains(line, "[env]") || !strings.Contains(line, "<-- WARN") {
			t.Errorf("summary line for %s not flagged: %q", env, line)
		}
	}
}

// The removed workers must not come back through the registry or the interval specs.
func TestRemovedWorkersAreGone(t *testing.T) {
	clearIntervalEnv(t)
	captureLog(t)
	got := workerIntervals(NewCronService())
	for _, id := range []string{"fomo_ws", "gmgn_roster_watch", "rh_lp_screen", "filtered_trending", "mcap_tracker_sim_open"} {
		if _, ok := got[id]; ok {
			t.Errorf("worker %s is still registered", id)
		}
	}
	for _, s := range intervalSpecs {
		switch s.Field {
		case "GmgnRosterWatchInterval", "RhLpScreenInterval", "McapTrackerSimOpenInterval":
			t.Errorf("interval spec %s should have been removed", s.Field)
		}
	}
}

// resolveInterval is pure: no env, no logging, deterministic.
func TestResolveIntervalIsPure(t *testing.T) {
	s := intervalSpec{Field: "X", Env: "X_INTERVAL", Default: 60, AllowZero: false}
	env := map[string]string{"X_INTERVAL": " 120 "}
	lookup := func(k string) string { return env[k] }
	r := resolveInterval(s, lookup)
	if r.Seconds != 120 || r.Source != "env" {
		t.Fatalf("got %+v", r)
	}
	delete(env, "X_INTERVAL")
	if r := resolveInterval(s, lookup); r.Seconds != 60 || r.Source != "default" {
		t.Fatalf("got %+v", r)
	}
}
