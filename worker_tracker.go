package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/robfig/cron/v3"
)

type WorkerMeta struct {
	ID            string
	Name          string
	Domain        string
	Schedule      string
	IntervalSec   int
	Disabled      bool
	TriggerPath   string
	CanTrigger    bool
}

type workerRuntime struct {
	lastStartedAt *time.Time
	lastSuccessAt *time.Time
	lastErrorAt   *time.Time
	lastErrorMsg  string
	nextRunAt     *time.Time
}

type WorkerTracker struct {
	mu              sync.RWMutex
	meta            map[string]WorkerMeta
	runtime         map[string]*workerRuntime
	entryIDToWorker map[cron.EntryID]string
}

func NewWorkerTracker() *WorkerTracker {
	return &WorkerTracker{
		meta:            make(map[string]WorkerMeta),
		runtime:         make(map[string]*workerRuntime),
		entryIDToWorker: make(map[cron.EntryID]string),
	}
}

func (wt *WorkerTracker) Register(meta WorkerMeta) {
	wt.mu.Lock()
	defer wt.mu.Unlock()
	wt.meta[meta.ID] = meta
	if _, ok := wt.runtime[meta.ID]; !ok {
		wt.runtime[meta.ID] = &workerRuntime{}
	}
}

func (wt *WorkerTracker) BindEntry(entryID cron.EntryID, workerID string) {
	wt.mu.Lock()
	defer wt.mu.Unlock()
	wt.entryIDToWorker[entryID] = workerID
}

func (wt *WorkerTracker) SyncNextRuns(entries []cron.Entry) {
	wt.mu.Lock()
	defer wt.mu.Unlock()
	for _, entry := range entries {
		workerID, ok := wt.entryIDToWorker[entry.ID]
		if !ok {
			continue
		}
		rt, exists := wt.runtime[workerID]
		if !exists {
			rt = &workerRuntime{}
			wt.runtime[workerID] = rt
		}
		next := entry.Next
		rt.nextRunAt = &next
	}
}

func (wt *WorkerTracker) Begin(id string) {
	wt.mu.Lock()
	defer wt.mu.Unlock()
	rt := wt.ensureRuntime(id)
	now := time.Now().UTC()
	rt.lastStartedAt = &now
}

func (wt *WorkerTracker) Success(id string) {
	wt.mu.Lock()
	defer wt.mu.Unlock()
	rt := wt.ensureRuntime(id)
	now := time.Now().UTC()
	rt.lastSuccessAt = &now
	rt.lastErrorMsg = ""
}

func (wt *WorkerTracker) Fail(id string, msg string) {
	wt.mu.Lock()
	defer wt.mu.Unlock()
	rt := wt.ensureRuntime(id)
	now := time.Now().UTC()
	rt.lastErrorAt = &now
	rt.lastErrorMsg = msg
}

func (wt *WorkerTracker) ensureRuntime(id string) *workerRuntime {
	rt, ok := wt.runtime[id]
	if !ok {
		rt = &workerRuntime{}
		wt.runtime[id] = rt
	}
	return rt
}

func (wt *WorkerTracker) workerStatus(meta WorkerMeta, rt *workerRuntime) string {
	if meta.Disabled {
		return "disabled"
	}
	if rt == nil || rt.lastSuccessAt == nil {
		if rt != nil && rt.lastErrorAt != nil {
			return "error"
		}
		return "never_run"
	}
	if meta.IntervalSec > 0 {
		staleAfter := time.Duration(meta.IntervalSec*2) * time.Second
		if time.Since(*rt.lastSuccessAt) > staleAfter {
			return "stale"
		}
	}
	if rt.lastErrorAt != nil && rt.lastSuccessAt != nil && rt.lastErrorAt.After(*rt.lastSuccessAt) {
		return "error"
	}
	return "ok"
}

func formatTimePtr(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

func (wt *WorkerTracker) Snapshot() []map[string]interface{} {
	wt.mu.RLock()
	defer wt.mu.RUnlock()

	out := make([]map[string]interface{}, 0, len(wt.meta))
	for id, meta := range wt.meta {
		rt := wt.runtime[id]
		status := wt.workerStatus(meta, rt)
		row := map[string]interface{}{
			"id":              id,
			"name":            meta.Name,
			"domain":          meta.Domain,
			"schedule":        meta.Schedule,
			"interval_sec":    meta.IntervalSec,
			"disabled":        meta.Disabled,
			"can_trigger":     meta.CanTrigger,
			"trigger_path":    meta.TriggerPath,
			"status":          status,
			"last_started_at": "",
			"last_success_at": "",
			"last_error_at":   "",
			"last_error_msg":  "",
			"next_run_at":     "",
		}
		if rt != nil {
			row["last_started_at"] = formatTimePtr(rt.lastStartedAt)
			row["last_success_at"] = formatTimePtr(rt.lastSuccessAt)
			row["last_error_at"] = formatTimePtr(rt.lastErrorAt)
			row["last_error_msg"] = rt.lastErrorMsg
			row["next_run_at"] = formatTimePtr(rt.nextRunAt)
		}
		out = append(out, row)
	}
	return out
}

func (cs *CronService) initWorkerRegistry() {
	workers := []WorkerMeta{
		{ID: "signals_sim_track", Name: "Signals sim track", Domain: "algo", Schedule: "every Ns", IntervalSec: cs.config.SignalsSimInterval, TriggerPath: "/trigger/signals-sim-track", CanTrigger: true},
		{ID: "mcap_tracker_sim_track", Name: "MCap tracker sim track", Domain: "algo", Schedule: "every Ns", IntervalSec: cs.config.McapTrackerSimInterval, TriggerPath: "/trigger/mcap-tracker-sim-track", CanTrigger: true},
		{ID: "signals_refresh", Name: "Signals refresh", Domain: "algo", Schedule: "every Ns", IntervalSec: cs.config.SignalRefreshInterval, TriggerPath: "/trigger/signals-refresh", CanTrigger: true},
		{ID: "trending_tracker", Name: "Trending tracker", Domain: "algo", Schedule: "every 5m", IntervalSec: 300, TriggerPath: "/trigger/trending", CanTrigger: true},
		{ID: "filtered_trending", Name: "Filtered trending", Domain: "algo", Schedule: "every 2m", IntervalSec: 120, CanTrigger: false},
		{ID: "unfiltered_trending", Name: "Unfiltered trending", Domain: "algo", Schedule: "every 2m", IntervalSec: 120, CanTrigger: false},
		{ID: "dlmm_screen", Name: "DLMM screen", Domain: "algo", Schedule: "every Ns", IntervalSec: cs.config.DLMMScreenInterval, TriggerPath: "/trigger/dlmm-screen", CanTrigger: true},
		{ID: "dlmm_sim_track", Name: "DLMM sim track", Domain: "algo", Schedule: "every Ns", IntervalSec: cs.config.DLMMSimTrackInterval, TriggerPath: "/trigger/dlmm-sim-track", CanTrigger: true},
		{ID: "dlmm_manage", Name: "DLMM manage", Domain: "algo", Schedule: "every Ns", IntervalSec: cs.config.DLMMManageInterval, TriggerPath: "/trigger/dlmm-manage", CanTrigger: true},
		{ID: "strategy_report", Name: "Strategy report digest", Domain: "algo", Schedule: "every Ns", IntervalSec: cs.config.StrategyReportInterval, TriggerPath: "/trigger/strategy-report", CanTrigger: true, Disabled: cs.config.StrategyReportInterval <= 0},
		{ID: "sltp_monitor", Name: "SL/TP monitor", Domain: "infra", Schedule: "every Ns", IntervalSec: cs.config.SLTPMonitorInterval, TriggerPath: "/trigger/sltp", CanTrigger: true},
		{ID: "daily_summary", Name: "Daily summary", Domain: "infra", Schedule: "daily 00:00 UTC", IntervalSec: 86400, TriggerPath: "/trigger/summary", CanTrigger: true},
		{ID: "pnl_update", Name: "PnL update", Domain: "infra", Schedule: "daily 02:00 UTC", IntervalSec: 86400, TriggerPath: "/trigger/pnl", CanTrigger: true},
	}
	for _, w := range workers {
		if w.IntervalSec > 0 && w.Schedule == "every Ns" {
			w.Schedule = formatScheduleSeconds(w.IntervalSec)
		}
		cs.workers.Register(w)
	}
}

func formatScheduleSeconds(sec int) string {
	if sec >= 3600 && sec%3600 == 0 {
		return fmt.Sprintf("every %dh", sec/3600)
	}
	if sec >= 60 && sec%60 == 0 {
		return fmt.Sprintf("every %dm", sec/60)
	}
	return fmt.Sprintf("every %ds", sec)
}

func (cs *CronService) workersCheck(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	cs.workers.SyncNextRuns(cs.cron.Entries())
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":        "running",
		"timestamp":     time.Now().UTC().Format(time.RFC3339),
		"service":       "reloadsol-cron-service",
		"uptime":        time.Since(startTime).String(),
		"cron_entries":  len(cs.cron.Entries()),
		"api_base_url":  cs.config.APIBaseURL,
		"workers":       cs.workers.Snapshot(),
	})
}
