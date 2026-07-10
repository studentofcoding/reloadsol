package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"runtime"
	"strings"
	"strconv"
	"sync"
	"time"

	"github.com/robfig/cron/v3"
	"github.com/shirou/gopsutil/v3/cpu"
)

// Track service start time for uptime calculation
var startTime time.Time

// Discord webhook message structure
type DiscordEmbed struct {
	Title       string                 `json:"title,omitempty"`
	Description string                 `json:"description,omitempty"`
	Color       int                    `json:"color,omitempty"`
	Timestamp   string                 `json:"timestamp,omitempty"`
	Fields      []DiscordEmbedField    `json:"fields,omitempty"`
	Footer      *DiscordEmbedFooter    `json:"footer,omitempty"`
}

type DiscordEmbedField struct {
	Name   string `json:"name"`
	Value  string `json:"value"`
	Inline bool   `json:"inline,omitempty"`
}

type DiscordEmbedFooter struct {
	Text string `json:"text"`
}

type DiscordMessage struct {
	Content string         `json:"content,omitempty"`
	Embeds  []DiscordEmbed `json:"embeds,omitempty"`
}

// Enhanced logger that sends to both stdout and Discord
type DiscordLogger struct {
	webhookURL   string
	serviceName  string
	logBuffer    []string
	bufferMutex  sync.Mutex
	lastSent     time.Time
	batchSize    int
	flushInterval time.Duration
}

func NewDiscordLogger(webhookURL, serviceName string) *DiscordLogger {
	dl := &DiscordLogger{
		webhookURL:    webhookURL,
		serviceName:   serviceName,
		logBuffer:     make([]string, 0),
		batchSize:     5,                // Send logs in batches of 5
		flushInterval: 30 * time.Second, // Force flush every 30 seconds
		lastSent:      time.Now(),
	}
	
	// Start background flush routine
	go dl.backgroundFlush()
	
	return dl
}

func (dl *DiscordLogger) Log(level, message string) {
	// Always log to stdout first
	timestamp := time.Now().UTC().Format("2006-01-02 15:04:05")
	logLine := fmt.Sprintf("[%s] %s: %s", timestamp, level, message)
	log.Println(logLine)
	
	// Add to Discord buffer if webhook is configured
	if dl.webhookURL != "" {
		dl.bufferMutex.Lock()
		dl.logBuffer = append(dl.logBuffer, fmt.Sprintf("[%s] %s", level, message))
		shouldFlush := len(dl.logBuffer) >= dl.batchSize
		dl.bufferMutex.Unlock()
		
		if shouldFlush {
			go dl.flushToDiscord()
		}
	}
}

func (dl *DiscordLogger) Info(message string) {
	dl.Log("INFO", message)
}

func (dl *DiscordLogger) Error(message string) {
	dl.Log("ERROR", message)
}

func (dl *DiscordLogger) Success(message string) {
	dl.Log("SUCCESS", message)
}

func (dl *DiscordLogger) Warning(message string) {
	dl.Log("WARNING", message)
}

func (dl *DiscordLogger) backgroundFlush() {
	ticker := time.NewTicker(dl.flushInterval)
	defer ticker.Stop()
	
	for range ticker.C {
		dl.bufferMutex.Lock()
		hasLogs := len(dl.logBuffer) > 0
		dl.bufferMutex.Unlock()
		
		if hasLogs {
			dl.flushToDiscord()
		}
	}
}

func (dl *DiscordLogger) flushToDiscord() {
	dl.bufferMutex.Lock()
	if len(dl.logBuffer) == 0 {
		dl.bufferMutex.Unlock()
		return
	}
	
	// Copy and clear buffer
	logs := make([]string, len(dl.logBuffer))
	copy(logs, dl.logBuffer)
	dl.logBuffer = dl.logBuffer[:0]
	dl.bufferMutex.Unlock()
	
	// Format logs for Discord
	logText := strings.Join(logs, "\n")
	if len(logText) > 1900 { // Discord limit is 2000 chars, leave some buffer
		logText = logText[:1900] + "...\n[truncated]"
	}
	
	// Determine embed color based on log content
	color := 3447003 // Blue by default
	if strings.Contains(logText, "ERROR") || strings.Contains(logText, "❌") {
		color = 15158332 // Red
	} else if strings.Contains(logText, "SUCCESS") || strings.Contains(logText, "✅") {
		color = 3066993 // Green
	} else if strings.Contains(logText, "WARNING") {
		color = 15105570 // Orange
	}
	
	embed := DiscordEmbed{
		Title:       fmt.Sprintf("🤖 %s Logs", dl.serviceName),
		Description: fmt.Sprintf("```\n%s\n```", logText),
		Color:       color,
		Timestamp:   time.Now().UTC().Format(time.RFC3339),
		Footer: &DiscordEmbedFooter{
			Text: fmt.Sprintf("%s • %d logs", dl.serviceName, len(logs)),
		},
	}
	
	message := DiscordMessage{
		Embeds: []DiscordEmbed{embed},
	}
	
	// Send to Discord
	dl.sendToDiscord(message)
	dl.lastSent = time.Now()
}

func (dl *DiscordLogger) sendToDiscord(message DiscordMessage) {
	jsonData, err := json.Marshal(message)
	if err != nil {
		log.Printf("Failed to marshal Discord message: %v", err)
		return
	}
	
	client := &http.Client{Timeout: 10 * time.Second}
	
	resp, err := client.Post(dl.webhookURL, "application/json", bytes.NewBuffer(jsonData))
	if err != nil {
		log.Printf("Failed to send to Discord webhook: %v", err)
		return
	}
	defer resp.Body.Close()
	
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		log.Printf("Discord webhook error %d: %s", resp.StatusCode, string(body))
	}
}

// Send immediate Discord notification (for important events)
func (dl *DiscordLogger) SendImmediate(title, message string, color int) {
	if dl.webhookURL == "" {
		return
	}
	
	embed := DiscordEmbed{
		Title:       title,
		Description: message,
		Color:       color,
		Timestamp:   time.Now().UTC().Format(time.RFC3339),
		Footer: &DiscordEmbedFooter{
			Text: dl.serviceName,
		},
	}
	
	discordMsg := DiscordMessage{
		Embeds: []DiscordEmbed{embed},
	}
	
	go dl.sendToDiscord(discordMsg)
}

type Config struct {
    APIBaseURL     string
    TrendingSecret string
    PnLSecret      string
    DiscordWebhook string
    SLTPMonitorInterval  int    // seconds
    SignalRefreshInterval int   // seconds
    SignalsSimInterval   int    // seconds
    McapTrackerSimInterval int  // seconds
    GmgnSimInterval      int    // seconds
    GmgnActivityPollInterval int // seconds
    StrategyReportInterval int  // seconds (0 = disabled)
    DLMMScreenInterval int    // seconds
    DLMMSimTrackInterval int // seconds
    DLMMManageInterval int    // seconds
    DLMMSecret         string
}

type CronService struct {
	config  *Config
	cron    *cron.Cron
	logger  *DiscordLogger
	workers *WorkerTracker
}

func NewCronService() *CronService {
    config := &Config{
        APIBaseURL:     getEnv("API_BASE_URL", "https://reloadsol.app"),
        TrendingSecret: getEnv("TRENDING_TRACKER_SECRET", "r3l0ads0l-trending"),
        PnLSecret:      getEnv("PNL_UPDATE_SECRET", "r3l0ads0l-pnl"),
        DiscordWebhook: getEnv("DISCORD_WEBHOOK_URL", ""),
        SLTPMonitorInterval: func() int {
            if v := os.Getenv("SLTP_MONITOR_INTERVAL"); v != "" {
                if iv, err := strconv.Atoi(v); err == nil && iv > 0 {
                    return iv
                }
            }
            return 60 // default 60s
        }(),
        SignalRefreshInterval: func() int {
            if v := os.Getenv("SIGNAL_REFRESH_INTERVAL"); v != "" {
                if iv, err := strconv.Atoi(v); err == nil && iv > 0 {
                    return iv
                }
            }
            return 60 // default 60s
        }(),
        SignalsSimInterval: func() int {
            if v := os.Getenv("SIGNALS_SIM_INTERVAL"); v != "" {
                if iv, err := strconv.Atoi(v); err == nil && iv > 0 {
                    return iv
                }
            }
            return 120 // default 120s
        }(),
        McapTrackerSimInterval: func() int {
            if v := os.Getenv("MCAP_TRACKER_SIM_INTERVAL"); v != "" {
                if iv, err := strconv.Atoi(v); err == nil && iv > 0 {
                    return iv
                }
            }
            return 120 // default 120s
        }(),
        GmgnSimInterval: func() int {
            if v := os.Getenv("GMGN_SIM_INTERVAL"); v != "" {
                if iv, err := strconv.Atoi(v); err == nil && iv > 0 {
                    return iv
                }
            }
            return 120 // default 120s
        }(),
        GmgnActivityPollInterval: func() int {
            if v := os.Getenv("GMGN_ACTIVITY_POLL_INTERVAL"); v != "" {
                if iv, err := strconv.Atoi(v); err == nil && iv > 0 {
                    return iv
                }
            }
            return 180 // default 180s
        }(),
        StrategyReportInterval: func() int {
            if v := os.Getenv("STRATEGY_REPORT_INTERVAL"); v != "" {
                if iv, err := strconv.Atoi(v); err == nil && iv >= 0 {
                    return iv
                }
            }
            return 86400 // default daily (86400s); set 0 to disable
        }(),
        DLMMScreenInterval: func() int {
            if v := os.Getenv("DLMM_SCREEN_INTERVAL"); v != "" {
                if iv, err := strconv.Atoi(v); err == nil && iv > 0 {
                    return iv
                }
            }
            return 300 // 5m
        }(),
        DLMMSimTrackInterval: func() int {
            if v := os.Getenv("DLMM_SIM_TRACK_INTERVAL"); v != "" {
                if iv, err := strconv.Atoi(v); err == nil && iv > 0 {
                    return iv
                }
            }
            return 300 // 5m
        }(),
        DLMMManageInterval: func() int {
            if v := os.Getenv("DLMM_MANAGE_INTERVAL"); v != "" {
                if iv, err := strconv.Atoi(v); err == nil && iv > 0 {
                    return iv
                }
            }
            return 60
        }(),
        DLMMSecret: getEnv("DLMM_MANAGE_SECRET", getEnv("TRENDING_TRACKER_SECRET", "r3l0ads0l-trending")),
    }

	c := cron.New(cron.WithSeconds())
	
	// Initialize Discord logger
	logger := NewDiscordLogger(config.DiscordWebhook, "ReloadSol Cron Service")
	
	return &CronService{
		config:  config,
		cron:    c,
		logger:  logger,
		workers: NewWorkerTracker(),
	}
}

func (cs *CronService) Start() {
	cs.logger.Info("🚀 Starting Cron Service for reloadsol...")
	cs.initWorkerRegistry()
	cs.workers.SetOnChange(func(workerID, event, msg string) {
		cs.persistWorkerRuntimeEvent(workerID, event, msg)
	})
	cs.hydrateWorkerRuntime()

	// Send startup notification
	if cs.config.DiscordWebhook != "" {
		cs.logger.SendImmediate(
			"🚀 Cron Service Started",
			"ReloadSol Cron Service is now online and ready to execute scheduled tasks.",
			3066993, // Green
		)
	}

	// Trending tracker - every 5 minutes
	trendingEntryID, err := cs.cron.AddFunc("0 */5 * * * *", cs.runTrendingTracker)
	if err != nil {
		cs.logger.Error(fmt.Sprintf("Failed to add trending tracker cron job: %v", err))
		log.Fatal("Failed to add trending tracker cron job:", err)
	}
	cs.workers.BindEntry(trendingEntryID, "trending_tracker")

	// Filtered trending tracker - every 2 minutes
	filteredEntryID, err := cs.cron.AddFunc("0 */2 * * * *", cs.runFilteredTrendingTracker)
	if err != nil {
		cs.logger.Error(fmt.Sprintf("Failed to add filtered trending tracker cron job: %v", err))
		log.Fatal("Failed to add filtered trending tracker cron job:", err)
	}
	cs.workers.BindEntry(filteredEntryID, "filtered_trending")

	// Trending tracker unfiltered - every 2 minutes
	unfilteredEntryID, err := cs.cron.AddFunc("0 */2 * * * *", cs.runUnfilteredTrendingTracker)
	if err != nil {
		cs.logger.Error(fmt.Sprintf("Failed to add unfiltered trending tracker cron job: %v", err))
		log.Fatal("Failed to add unfiltered trending tracker cron job:", err)
	}
	cs.workers.BindEntry(unfilteredEntryID, "unfiltered_trending")

    // SL/TP monitor – every M seconds (default 60)
    sltpSpec := fmt.Sprintf("@every %ds", cs.config.SLTPMonitorInterval)
    sltpEntryID, err := cs.cron.AddFunc(sltpSpec, cs.runSLTPMonitor)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("Failed to add SL/TP monitor cron job: %v", err))
        log.Fatal("Failed to add SL/TP monitor cron job:", err)
    }
    cs.workers.BindEntry(sltpEntryID, "sltp_monitor")

    // Signals refresh – every K seconds (default 60)
    sigSpec := fmt.Sprintf("@every %ds", cs.config.SignalRefreshInterval)
    sigRefreshEntryID, err := cs.cron.AddFunc(sigSpec, cs.runSignalRefresh)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("Failed to add signals refresh cron job: %v", err))
        log.Fatal("Failed to add signals refresh cron job:", err)
    }
    cs.workers.BindEntry(sigRefreshEntryID, "signals_refresh")

    // Signals sim track – every N seconds (default 120)
    signalsSimSpec := fmt.Sprintf("@every %ds", cs.config.SignalsSimInterval)
    signalsSimEntryID, err := cs.cron.AddFunc(signalsSimSpec, cs.runSignalsSimTrack)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("Failed to add signals sim track cron job: %v", err))
        log.Fatal("Failed to add signals sim track cron job:", err)
    }
    cs.workers.BindEntry(signalsSimEntryID, "signals_sim_track")

    mcapTrackerSimSpec := fmt.Sprintf("@every %ds", cs.config.McapTrackerSimInterval)
    mcapTrackerSimEntryID, err := cs.cron.AddFunc(mcapTrackerSimSpec, cs.runMcapTrackerSimTrack)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("Failed to add mcap tracker sim track cron job: %v", err))
        log.Fatal("Failed to add mcap tracker sim track cron job:", err)
    }
    cs.workers.BindEntry(mcapTrackerSimEntryID, "mcap_tracker_sim_track")

    gmgnSimSpec := fmt.Sprintf("@every %ds", cs.config.GmgnSimInterval)
    gmgnSimEntryID, err := cs.cron.AddFunc(gmgnSimSpec, cs.runGmgnSimTrack)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("Failed to add GMGN sim track cron job: %v", err))
        log.Fatal("Failed to add GMGN sim track cron job:", err)
    }
    cs.workers.BindEntry(gmgnSimEntryID, "gmgn_sim_track")

    gmgnActivityPollSpec := fmt.Sprintf("@every %ds", cs.config.GmgnActivityPollInterval)
    gmgnActivityPollEntryID, err := cs.cron.AddFunc(gmgnActivityPollSpec, cs.runGmgnActivityPoll)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("Failed to add GMGN activity poll cron job: %v", err))
        log.Fatal("Failed to add GMGN activity poll cron job:", err)
    }
    cs.workers.BindEntry(gmgnActivityPollEntryID, "gmgn_activity_poll")

    socialRollupEntryID, err := cs.cron.AddFunc("@every 300s", cs.runSocialRollup)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("Failed to add social rollup cron job: %v", err))
        log.Fatal("Failed to add social rollup cron job:", err)
    }
    cs.workers.BindEntry(socialRollupEntryID, "social_rollup")

    socialWalletPollEntryID, err := cs.cron.AddFunc("@every 300s", cs.runSocialWalletPoll)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("Failed to add social wallet poll cron job: %v", err))
        log.Fatal("Failed to add social wallet poll cron job:", err)
    }
    cs.workers.BindEntry(socialWalletPollEntryID, "social_wallet_poll")

    socialCleanupEntryID, err := cs.cron.AddFunc("@every 30m", cs.runSocialCleanup)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("Failed to add social cleanup cron job: %v", err))
        log.Fatal("Failed to add social cleanup cron job:", err)
    }
    cs.workers.BindEntry(socialCleanupEntryID, "social_cleanup")

    if cs.config.StrategyReportInterval > 0 {
        reportSpec := fmt.Sprintf("@every %ds", cs.config.StrategyReportInterval)
        reportEntryID, err := cs.cron.AddFunc(reportSpec, cs.runStrategyReportDigest)
        if err != nil {
            cs.logger.Error(fmt.Sprintf("Failed to add strategy report digest cron job: %v", err))
            log.Fatal("Failed to add strategy report digest cron job:", err)
        }
        cs.workers.BindEntry(reportEntryID, "strategy_report")
    }

    // DLMM screen – every N seconds (default 300)
    dlmmScreenSpec := fmt.Sprintf("@every %ds", cs.config.DLMMScreenInterval)
    dlmmScreenEntryID, err := cs.cron.AddFunc(dlmmScreenSpec, cs.runDLMMScreen)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("Failed to add DLMM screen cron job: %v", err))
        log.Fatal("Failed to add DLMM screen cron job:", err)
    }
    cs.workers.BindEntry(dlmmScreenEntryID, "dlmm_screen")

    dlmmSimTrackSpec := fmt.Sprintf("@every %ds", cs.config.DLMMSimTrackInterval)
    dlmmSimTrackEntryID, err := cs.cron.AddFunc(dlmmSimTrackSpec, cs.runDLMMSimTrack)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("Failed to add DLMM sim track cron job: %v", err))
        log.Fatal("Failed to add DLMM sim track cron job:", err)
    }
    cs.workers.BindEntry(dlmmSimTrackEntryID, "dlmm_sim_track")

    // DLMM manage – every M seconds (default 60)
    dlmmManageSpec := fmt.Sprintf("@every %ds", cs.config.DLMMManageInterval)
    dlmmManageEntryID, err := cs.cron.AddFunc(dlmmManageSpec, cs.runDLMMManage)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("Failed to add DLMM manage cron job: %v", err))
        log.Fatal("Failed to add DLMM manage cron job:", err)
    }
    cs.workers.BindEntry(dlmmManageEntryID, "dlmm_manage")

    // Daily summary - once per day at midnight UTC
    summaryEntryID, err := cs.cron.AddFunc("0 0 0 * * *", cs.runDailySummary)
	if err != nil {
		cs.logger.Error(fmt.Sprintf("Failed to add daily summary cron job: %v", err))
		log.Fatal("Failed to add daily summary cron job:", err)
	}
	cs.workers.BindEntry(summaryEntryID, "daily_summary")

	// PnL update - daily at 2 AM UTC
	pnlEntryID, err := cs.cron.AddFunc("0 0 2 * * *", cs.runPnLUpdate)
	if err != nil {
		cs.logger.Error(fmt.Sprintf("Failed to add PnL update cron job: %v", err))
		log.Fatal("Failed to add PnL update cron job:", err)
	}
	cs.workers.BindEntry(pnlEntryID, "pnl_update")

	// Health check endpoint
	http.HandleFunc("/health", cs.healthCheck)
	http.HandleFunc("/status", cs.statusCheck)
	http.HandleFunc("/workers", cs.workersCheck)
	http.HandleFunc("/trigger/trending", cs.manualTrendingTrigger)
	http.HandleFunc("/trigger/summary", cs.manualSummaryTrigger)
	http.HandleFunc("/trigger/pnl", cs.manualPnLTrigger)
	http.HandleFunc("/trigger/sltp", cs.manualSLTPTrigger)
	http.HandleFunc("/trigger/signals-refresh", cs.manualSignalsRefreshTrigger)
    http.HandleFunc("/trigger/signals-sim-track", cs.manualSignalsSimTrackTrigger)
    http.HandleFunc("/trigger/mcap-tracker-sim-track", cs.manualMcapTrackerSimTrackTrigger)
    http.HandleFunc("/trigger/gmgn-sim-track", cs.manualGmgnSimTrackTrigger)
    http.HandleFunc("/trigger/gmgn-activity-poll", cs.manualGmgnActivityPollTrigger)
    http.HandleFunc("/trigger/social-rollup", cs.manualSocialRollupTrigger)
    http.HandleFunc("/trigger/social-cleanup", cs.manualSocialCleanupTrigger)
    http.HandleFunc("/trigger/social-wallet-poll", cs.manualSocialWalletPollTrigger)
    http.HandleFunc("/trigger/strategy-report", cs.manualStrategyReportTrigger)
    http.HandleFunc("/trigger/dlmm-screen", cs.manualDLMMScreenTrigger)
    http.HandleFunc("/trigger/dlmm-sim-track", cs.manualDLMMSimTrackTrigger)
    http.HandleFunc("/trigger/dlmm-manage", cs.manualDLMMManageTrigger)
    http.HandleFunc("/logs/test", cs.testDiscordLogs)

    cs.cron.Start()
    cs.logger.Success("✅ All cron jobs scheduled successfully")
    cs.logger.Info("📊 Trending tracker: every 5 minutes")
    cs.logger.Info("📊 Filtered trending tracker: every 2 minutes")
    cs.logger.Info("📊 Unfiltered trending tracker: every 2 minutes")
    cs.logger.Info(fmt.Sprintf("🛡️ SL/TP monitor: every %d seconds", cs.config.SLTPMonitorInterval))
    cs.logger.Info(fmt.Sprintf("📡 Signals refresh: every %d seconds", cs.config.SignalRefreshInterval))
    cs.logger.Info(fmt.Sprintf("🧪 Signals sim track: every %d seconds", cs.config.SignalsSimInterval))
    cs.logger.Info(fmt.Sprintf("📈 MCap tracker sim track: every %d seconds", cs.config.McapTrackerSimInterval))
    cs.logger.Info(fmt.Sprintf("🐋 GMGN sim track: every %d seconds", cs.config.GmgnSimInterval))
    cs.logger.Info(fmt.Sprintf("🔥 GMGN activity poll: every %d seconds", cs.config.GmgnActivityPollInterval))
    cs.logger.Info("📣 Social rollup: every 300 seconds")
    cs.logger.Info("🧹 Social cleanup: every 30 minutes")
    cs.logger.Info("👛 Social wallet poll: every 300 seconds")
    if cs.config.StrategyReportInterval > 0 {
        cs.logger.Info(fmt.Sprintf("📊 Strategy report digest: every %d seconds", cs.config.StrategyReportInterval))
    } else {
        cs.logger.Info("📊 Strategy report digest: disabled (STRATEGY_REPORT_INTERVAL=0)")
    }
    cs.logger.Info(fmt.Sprintf("🌊 DLMM screen: every %d seconds", cs.config.DLMMScreenInterval))
    cs.logger.Info(fmt.Sprintf("🧪 DLMM sim track: every %d seconds", cs.config.DLMMSimTrackInterval))
    cs.logger.Info(fmt.Sprintf("🩺 DLMM manage: every %d seconds", cs.config.DLMMManageInterval))
	cs.logger.Info("📋 Daily summary: daily at 00:00 UTC")
	cs.logger.Info("💰 PnL update: daily at 02:00 UTC" )
	cs.logger.Info("🔗 Health check: /health")
	cs.logger.Info("📈 Status check: /status")
	cs.logger.Info("📡 Signals refresh trigger: /trigger/signals-refresh")

	// Start HTTP server for health checks and manual triggers
	port := getEnv("PORT", "8080")
	cs.logger.Info(fmt.Sprintf("🌐 HTTP server starting on port %s", port))
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

// Manual trigger for signals refresh
func (cs *CronService) manualSignalsRefreshTrigger(w http.ResponseWriter, r *http.Request) {
    if r.Method != "POST" {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }
    cs.logger.Info("🔧 Manual signals refresh trigger")
    cs.runSignalRefresh()

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]string{
        "message":   "Signals refresh triggered manually",
        "timestamp": time.Now().UTC().Format(time.RFC3339),
    })
}

// Signals refresh: warm the signals endpoint to keep UI fresh
func (cs *CronService) runSignalRefresh() {
    cs.workers.Begin("signals_refresh")
    cs.logger.Info("📡 Running signals refresh...")

    url := fmt.Sprintf("%s/api/trading/signals", cs.config.APIBaseURL)

    // Conservative defaults; adjust via client or env as needed
    params := map[string]string{
        "limit":           "50",
        "recencyMinutes":  "180",
        "minGrowth":       "0",
        "includeStuck":    "false",
        "maxAgeMinutes":   "1440", // 4 days
    }

    resp, err := cs.makeRequest("GET", url, params)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("❌ Signals refresh failed: %v", err))
        cs.workers.Fail("signals_refresh", err.Error())
        return
    }

    // Parse minimal stats to log counts
    type signalsStats struct {
        Success bool `json:"success"`
        Stats struct {
            TotalCandidates int `json:"totalCandidates"`
            ReturnedSignals int `json:"returnedSignals"`
        } `json:"stats"`
    }

    var sr signalsStats
    if err := json.Unmarshal([]byte(resp), &sr); err == nil && sr.Success {
        cs.logger.Success(fmt.Sprintf("✅ Signals refreshed: %d returned / %d candidates", sr.Stats.ReturnedSignals, sr.Stats.TotalCandidates))
    } else {
        // Fallback: log raw length to avoid spam
        cs.logger.Success(fmt.Sprintf("✅ Signals refresh completed (response %d bytes)", len(resp)))
    }
    cs.workers.Success("signals_refresh")
}

func (cs *CronService) runSignalsSimTrack() {
    cs.workers.Begin("signals_sim_track")
    cs.logger.Info("🧪 Running signals sim track...")
    url := fmt.Sprintf("%s/api/signals/sim-track?key=%s", cs.config.APIBaseURL, cs.config.TrendingSecret)
    resp, err := cs.makeRequest("POST", url, nil)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("❌ Signals sim track failed: %v", err))
        cs.workers.Fail("signals_sim_track", err.Error())
        return
    }
    cs.logger.Success(fmt.Sprintf("✅ Signals sim track completed (%d bytes)", len(resp)))
    cs.workers.Success("signals_sim_track")
}

func (cs *CronService) runMcapTrackerSimTrack() {
    cs.workers.Begin("mcap_tracker_sim_track")
    cs.logger.Info("📈 Running mcap tracker sim track...")
    url := fmt.Sprintf("%s/api/mcap-tracking/sim-track?key=%s", cs.config.APIBaseURL, cs.config.TrendingSecret)
    resp, err := cs.makeRequest("POST", url, nil)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("❌ MCap tracker sim track failed: %v", err))
        cs.workers.Fail("mcap_tracker_sim_track", err.Error())
        return
    }
    cs.logger.Success(fmt.Sprintf("✅ MCap tracker sim track completed (%d bytes)", len(resp)))
    cs.workers.Success("mcap_tracker_sim_track")
}

func (cs *CronService) runGmgnSimTrack() {
    cs.workers.Begin("gmgn_sim_track")
    cs.logger.Info("🐋 Running GMGN sim track...")
    url := fmt.Sprintf("%s/api/gmgn/sim-track?key=%s", cs.config.APIBaseURL, cs.config.TrendingSecret)
    resp, err := cs.makeRequest("POST", url, nil, 180)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("❌ GMGN sim track failed: %v", err))
        cs.workers.Fail("gmgn_sim_track", err.Error())
        return
    }
    cs.logger.Success(fmt.Sprintf("✅ GMGN sim track completed (%d bytes)", len(resp)))
    cs.workers.Success("gmgn_sim_track")
}

func (cs *CronService) runGmgnActivityPoll() {
    cs.workers.Begin("gmgn_activity_poll")
    cs.logger.Info("🔥 Running GMGN activity poll...")
    url := fmt.Sprintf("%s/api/gmgn/activity-poll?key=%s", cs.config.APIBaseURL, cs.config.TrendingSecret)
    resp, err := cs.makeRequest("POST", url, nil, 180)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("❌ GMGN activity poll failed: %v", err))
        cs.workers.Fail("gmgn_activity_poll", err.Error())
        return
    }
    cs.logger.Success(fmt.Sprintf("✅ GMGN activity poll completed (%d bytes)", len(resp)))
    cs.workers.Success("gmgn_activity_poll")
}

func (cs *CronService) runSocialRollup() {
    cs.workers.Begin("social_rollup")
    cs.logger.Info("📣 Running social rollup...")
    url := fmt.Sprintf("%s/api/social/rollup?key=%s", cs.config.APIBaseURL, cs.config.TrendingSecret)
    resp, err := cs.makeRequest("POST", url, nil, 120)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("❌ Social rollup failed: %v", err))
        cs.workers.Fail("social_rollup", err.Error())
        return
    }
    cs.logger.Success(fmt.Sprintf("✅ Social rollup completed (%d bytes)", len(resp)))
    cs.workers.Success("social_rollup")
}

func (cs *CronService) runSocialCleanup() {
    cs.workers.Begin("social_cleanup")
    cs.logger.Info("🧹 Running social cleanup...")
    url := fmt.Sprintf("%s/api/social/cleanup?key=%s", cs.config.APIBaseURL, cs.config.TrendingSecret)
    resp, err := cs.makeRequest("POST", url, nil, 120)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("❌ Social cleanup failed: %v", err))
        cs.workers.Fail("social_cleanup", err.Error())
        return
    }
    cs.logger.Success(fmt.Sprintf("✅ Social cleanup completed (%d bytes)", len(resp)))
    cs.workers.Success("social_cleanup")
}

func (cs *CronService) runSocialWalletPoll() {
    cs.workers.Begin("social_wallet_poll")
    cs.logger.Info("👛 Running social wallet poll...")
    url := fmt.Sprintf("%s/api/social/wallet-poll?key=%s", cs.config.APIBaseURL, cs.config.TrendingSecret)
    resp, err := cs.makeRequest("POST", url, nil, 300)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("❌ Social wallet poll failed: %v", err))
        cs.workers.Fail("social_wallet_poll", err.Error())
        return
    }
    cs.logger.Success(fmt.Sprintf("✅ Social wallet poll completed (%d bytes)", len(resp)))
    cs.workers.Success("social_wallet_poll")
}

func (cs *CronService) runStrategyReportDigest() {
    cs.workers.Begin("strategy_report")
    cs.logger.Info("📊 Running strategy report digest...")
    url := fmt.Sprintf("%s/api/strategies/report-digest?key=%s", cs.config.APIBaseURL, cs.config.TrendingSecret)
    resp, err := cs.makeRequest("POST", url, nil)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("❌ Strategy report digest failed: %v", err))
        cs.workers.Fail("strategy_report", err.Error())
        return
    }
    cs.logger.Success(fmt.Sprintf("✅ Strategy report digest completed (%d bytes)", len(resp)))
    cs.workers.Success("strategy_report")
}

func (cs *CronService) manualSignalsSimTrackTrigger(w http.ResponseWriter, r *http.Request) {
    if r.Method != "POST" {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }
    cs.logger.Info("🔧 Manual signals sim track trigger")
    go cs.runSignalsSimTrack()
    json.NewEncoder(w).Encode(map[string]interface{}{
        "success": true,
        "message": "Signals sim track triggered",
        "timestamp": time.Now().UTC().Format(time.RFC3339),
    })
}

func (cs *CronService) manualMcapTrackerSimTrackTrigger(w http.ResponseWriter, r *http.Request) {
    if r.Method != "POST" {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }
    cs.logger.Info("🔧 Manual mcap tracker sim track trigger")
    go cs.runMcapTrackerSimTrack()
    json.NewEncoder(w).Encode(map[string]interface{}{
        "success": true,
        "message": "MCap tracker sim track triggered",
        "timestamp": time.Now().UTC().Format(time.RFC3339),
    })
}

func (cs *CronService) manualGmgnSimTrackTrigger(w http.ResponseWriter, r *http.Request) {
    if r.Method != "POST" {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }
    cs.logger.Info("🔧 Manual GMGN sim track trigger")
    go cs.runGmgnSimTrack()
    json.NewEncoder(w).Encode(map[string]interface{}{
        "success": true,
        "message": "GMGN sim track triggered",
        "timestamp": time.Now().UTC().Format(time.RFC3339),
    })
}

func (cs *CronService) manualGmgnActivityPollTrigger(w http.ResponseWriter, r *http.Request) {
    if r.Method != "POST" {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }
    cs.logger.Info("🔧 Manual GMGN activity poll trigger")
    go cs.runGmgnActivityPoll()
    json.NewEncoder(w).Encode(map[string]interface{}{
        "success": true,
        "message": "GMGN activity poll triggered",
        "timestamp": time.Now().UTC().Format(time.RFC3339),
    })
}

func (cs *CronService) manualSocialRollupTrigger(w http.ResponseWriter, r *http.Request) {
    if r.Method != "POST" {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }
    cs.logger.Info("🔧 Manual social rollup trigger")
    go cs.runSocialRollup()
    json.NewEncoder(w).Encode(map[string]interface{}{
        "success": true,
        "message": "Social rollup triggered",
        "timestamp": time.Now().UTC().Format(time.RFC3339),
    })
}

func (cs *CronService) manualSocialCleanupTrigger(w http.ResponseWriter, r *http.Request) {
    if r.Method != "POST" {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }
    cs.logger.Info("🔧 Manual social cleanup trigger")
    go cs.runSocialCleanup()
    json.NewEncoder(w).Encode(map[string]interface{}{
        "success": true,
        "message": "Social cleanup triggered",
        "timestamp": time.Now().UTC().Format(time.RFC3339),
    })
}

func (cs *CronService) manualSocialWalletPollTrigger(w http.ResponseWriter, r *http.Request) {
    if r.Method != "POST" {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }
    cs.logger.Info("🔧 Manual social wallet poll trigger")
    go cs.runSocialWalletPoll()
    json.NewEncoder(w).Encode(map[string]interface{}{
        "success": true,
        "message": "Social wallet poll triggered",
        "timestamp": time.Now().UTC().Format(time.RFC3339),
    })
}

func (cs *CronService) manualStrategyReportTrigger(w http.ResponseWriter, r *http.Request) {
    if r.Method != "POST" {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }
    cs.logger.Info("🔧 Manual strategy report trigger")
    go cs.runStrategyReportDigest()
    json.NewEncoder(w).Encode(map[string]interface{}{
        "success": true,
        "message": "Strategy report digest triggered",
        "timestamp": time.Now().UTC().Format(time.RFC3339),
    })
}

func (cs *CronService) runTrendingTracker() {
	cs.workers.Begin("trending_tracker")
	cs.logger.Info("🔍 Running trending tracker...")
	
	url := fmt.Sprintf("%s/api/trending/track", cs.config.APIBaseURL)
	
	resp, err := cs.makeRequest("POST", url, map[string]string{
		"key": cs.config.TrendingSecret,
	}, 300)
	
	if err != nil {
		cs.logger.Error(fmt.Sprintf("❌ Trending tracker failed: %v", err))
		cs.logger.SendImmediate(
			"❌ Trending Tracker Failed",
			fmt.Sprintf("Error: %v", err),
			15158332, // Red
		)
		cs.workers.Fail("trending_tracker", err.Error())
		return
	}
	
	cs.logger.Success(fmt.Sprintf("✅ Trending tracker completed: %s", resp))
	cs.workers.Success("trending_tracker")
}

func (cs *CronService) runFilteredTrendingTracker() {
    cs.workers.Begin("filtered_trending")
    cs.logger.Info("🔍 Running filtered trending tracker...")
    
    url := fmt.Sprintf("%s/api/trending/filtered", cs.config.APIBaseURL)
    
    resp, err := cs.makeRequest("POST", url, map[string]string{
        "key": cs.config.TrendingSecret,
    })
    
    if err != nil {
        cs.logger.Error(fmt.Sprintf("❌ Filtered trending tracker failed: %v", err))
        cs.logger.SendImmediate(
            "❌ Filtered Trending Tracker Failed",
            fmt.Sprintf("Error: %v", err),
            15158332, // Red
        )
        cs.workers.Fail("filtered_trending", err.Error())
        return
    }
    
    cs.logger.Success(fmt.Sprintf("✅ Filtered trending tracker completed: %s", resp))
    cs.workers.Success("filtered_trending")
}

func (cs *CronService) runUnfilteredTrendingTracker() {
    cs.workers.Begin("unfiltered_trending")
    cs.logger.Info("🔍 Running unfiltered trending tracker...")
    
    url := fmt.Sprintf("%s/api/trending", cs.config.APIBaseURL)
    
    resp, err := cs.makeRequest("POST", url, map[string]string{
        "key": cs.config.TrendingSecret,
    })
    
    if err != nil {
        cs.logger.Error(fmt.Sprintf("❌ Unfiltered trending tracker failed: %v", err))
        cs.logger.SendImmediate(
            "❌ Unfiltered Trending Tracker Failed",
            fmt.Sprintf("Error: %v", err),
            15158332, // Red
        )
        cs.workers.Fail("unfiltered_trending", err.Error())
        return
    }
    
    cs.logger.Success(fmt.Sprintf("✅ Unfiltered trending tracker completed: %s", resp))
    cs.workers.Success("unfiltered_trending")
}


func (cs *CronService) runDailySummary() {
	cs.workers.Begin("daily_summary")
	cs.logger.Info("📊 Running daily summary...")
	
	url := fmt.Sprintf("%s/api/trending/summary", cs.config.APIBaseURL)
	
	resp, err := cs.makeRequest("POST", url, map[string]string{
		"key": cs.config.TrendingSecret,
	})
	
	if err != nil {
		cs.logger.Error(fmt.Sprintf("❌ Daily summary failed: %v", err))
		cs.logger.SendImmediate(
			"❌ Daily Summary Failed",
			fmt.Sprintf("Error: %v", err),
			15158332, // Red
		)
		cs.workers.Fail("daily_summary", err.Error())
		return
	}
	
	cs.logger.Success(fmt.Sprintf("✅ Daily summary completed: %s", resp))
	cs.workers.Success("daily_summary")
}

func (cs *CronService) runPnLUpdate() {
	cs.workers.Begin("pnl_update")
	cs.logger.Info("💰 Running PnL update...")
	
	url := fmt.Sprintf("%s/api/pnl/update", cs.config.APIBaseURL)
	
	resp, err := cs.makeRequest("POST", url, map[string]string{
		"key": cs.config.PnLSecret,
	})
	
	if err != nil {
		cs.logger.Error(fmt.Sprintf("❌ PnL update failed: %v", err))
		cs.logger.SendImmediate(
			"❌ PnL Update Failed",
			fmt.Sprintf("Error: %v", err),
			15158332, // Red
		)
		cs.workers.Fail("pnl_update", err.Error())
		return
	}
	
	cs.logger.Success(fmt.Sprintf("✅ PnL update completed: %s", resp))
	cs.workers.Success("pnl_update")
}

// SL/TP Monitor Response structure
type SLTPMonitorResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Counts  struct {
		Active            int `json:"active"`
		Finished          int `json:"finished"`
		TotalTrackedTokens int `json:"totalTrackedTokens"`
	} `json:"counts"`
	Summary struct {
		Statistics struct {
			TotalActive   int `json:"total_active"`
			TotalFinished int `json:"total_finished"`
			ActiveByType  struct {
				Manual int `json:"manual"`
				Bot    int `json:"bot"`
			} `json:"active_by_type"`
			FinishedByTrigger struct {
				StopLoss     int `json:"stop_loss"`
				TakeProfit1  int `json:"take_profit_1"`
				TakeProfit2  int `json:"take_profit_2"`
				TakeProfit3  int `json:"take_profit_3"`
			} `json:"finished_by_trigger"`
			TotalTrackedTokens int `json:"total_tracked_tokens"`
			UniqueWallets      int `json:"unique_wallets"`
		} `json:"statistics"`
		LastMonitorRun string `json:"last_monitor_run"`
	} `json:"summary"`
}

func (cs *CronService) runSLTPMonitor() {
	cs.workers.Begin("sltp_monitor")
	cs.logger.Info("🛡️ Running SL/TP monitor...")

	url := fmt.Sprintf("%s/api/sl-tp-monitor", cs.config.APIBaseURL)

	resp, err := cs.makeRequest("GET", url, map[string]string{
		"key": cs.config.TrendingSecret,
	}, 120)
	if err != nil {
		cs.logger.Error(fmt.Sprintf("❌ SL/TP monitor failed: %v", err))
		cs.workers.Fail("sltp_monitor", err.Error())
		return
	}

	// Parse the JSON response
	var monitorResp SLTPMonitorResponse
	if err := json.Unmarshal([]byte(resp), &monitorResp); err != nil {
		cs.logger.Error(fmt.Sprintf("❌ Failed to parse SL/TP monitor response: %v", err))
		cs.logger.Info(fmt.Sprintf("Raw response: %s", resp))
		cs.workers.Fail("sltp_monitor", err.Error())
		return
	}

	if !monitorResp.Success {
		cs.logger.Error(fmt.Sprintf("❌ SL/TP monitor API returned error: %s", monitorResp.Message))
		cs.workers.Fail("sltp_monitor", monitorResp.Message)
		return
	}

	// Create detailed summary message
	stats := monitorResp.Summary.Statistics
	triggers := stats.FinishedByTrigger
	
	summaryMsg := fmt.Sprintf("Active: %d (Manual: %d, Bot: %d) | Finished: %d (SL: %d, TP1: %d, TP2: %d, TP3: %d) | Tracked Tokens: %d | Wallets: %d",
		stats.TotalActive,
		stats.ActiveByType.Manual,
		stats.ActiveByType.Bot,
		stats.TotalFinished,
		triggers.StopLoss,
		triggers.TakeProfit1,
		triggers.TakeProfit2,
		triggers.TakeProfit3,
		stats.TotalTrackedTokens,
		stats.UniqueWallets,
	)

	cs.logger.Success(fmt.Sprintf("✅ SL/TP monitor completed: %s", summaryMsg))

	// Send Discord notification for significant events (positions triggered)
	totalTriggered := triggers.StopLoss + triggers.TakeProfit1 + triggers.TakeProfit2 + triggers.TakeProfit3
	if totalTriggered > 0 {
		triggerDetails := fmt.Sprintf("🎯 **SL/TP Triggers Detected**\n\n")
		if triggers.StopLoss > 0 {
			triggerDetails += fmt.Sprintf("🔴 Stop Loss: %d positions\n", triggers.StopLoss)
		}
		if triggers.TakeProfit1 > 0 {
			triggerDetails += fmt.Sprintf("🟢 Take Profit 1: %d positions\n", triggers.TakeProfit1)
		}
		if triggers.TakeProfit2 > 0 {
			triggerDetails += fmt.Sprintf("🟢 Take Profit 2: %d positions\n", triggers.TakeProfit2)
		}
		if triggers.TakeProfit3 > 0 {
			triggerDetails += fmt.Sprintf("🟢 Take Profit 3: %d positions\n", triggers.TakeProfit3)
		}
		triggerDetails += fmt.Sprintf("\n📊 **Current Status**\n")
		triggerDetails += fmt.Sprintf("Active Positions: %d\n", stats.TotalActive)
		triggerDetails += fmt.Sprintf("Tracked Tokens: %d\n", stats.TotalTrackedTokens)

		cs.logger.SendImmediate(
			"🛡️ SL/TP Positions Triggered",
			triggerDetails,
			15844367, // Orange color for alerts
		)
	}
	cs.workers.Success("sltp_monitor")
}

func (cs *CronService) manualSLTPTrigger(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cs.logger.Info("🔧 Manual SL/TP monitor trigger")
	cs.runSLTPMonitor()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"message":   "SL/TP monitor triggered manually",
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
}

func (cs *CronService) runDLMMScreen() {
    cs.workers.Begin("dlmm_screen")
    cs.logger.Info("🌊 Running DLMM screen...")
    url := fmt.Sprintf("%s/api/dlmm/screen", cs.config.APIBaseURL)
    resp, err := cs.makeRequest("POST", url, map[string]string{
        "key": cs.config.DLMMSecret,
    })
    if err != nil {
        cs.logger.Error(fmt.Sprintf("❌ DLMM screen failed: %v", err))
        cs.workers.Fail("dlmm_screen", err.Error())
        return
    }
    cs.logger.Success(fmt.Sprintf("✅ DLMM screen completed: %s", resp))
    cs.workers.Success("dlmm_screen")
}

func (cs *CronService) runDLMMSimTrack() {
    cs.workers.Begin("dlmm_sim_track")
    cs.logger.Info("🧪 Running DLMM sim track...")
    url := fmt.Sprintf("%s/api/dlmm/sim-track", cs.config.APIBaseURL)
    resp, err := cs.makeRequest("POST", url, map[string]string{
        "key": cs.config.DLMMSecret,
    })
    if err != nil {
        cs.logger.Error(fmt.Sprintf("❌ DLMM sim track failed: %v", err))
        cs.workers.Fail("dlmm_sim_track", err.Error())
        return
    }
    cs.logger.Success(fmt.Sprintf("✅ DLMM sim track completed: %s", resp))
    cs.workers.Success("dlmm_sim_track")
}

func (cs *CronService) runDLMMManage() {
    cs.workers.Begin("dlmm_manage")
    cs.logger.Info("🩺 Running DLMM manage...")
    url := fmt.Sprintf("%s/api/dlmm/manage", cs.config.APIBaseURL)
    resp, err := cs.makeRequest("POST", url, map[string]string{
        "key": cs.config.DLMMSecret,
    })
    if err != nil {
        cs.logger.Error(fmt.Sprintf("❌ DLMM manage failed: %v", err))
        cs.workers.Fail("dlmm_manage", err.Error())
        return
    }
    cs.logger.Success(fmt.Sprintf("✅ DLMM manage completed: %s", resp))
    cs.workers.Success("dlmm_manage")
}

func (cs *CronService) manualDLMMScreenTrigger(w http.ResponseWriter, r *http.Request) {
    if r.Method != "POST" {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }
    cs.logger.Info("🔧 Manual DLMM screen trigger")
    cs.runDLMMScreen()
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]string{
        "message":   "DLMM screen triggered manually",
        "timestamp": time.Now().UTC().Format(time.RFC3339),
    })
}

func (cs *CronService) manualDLMMSimTrackTrigger(w http.ResponseWriter, r *http.Request) {
    if r.Method != "POST" {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }
    cs.logger.Info("🔧 Manual DLMM sim track trigger")
    cs.runDLMMSimTrack()
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]string{
        "message":   "DLMM sim track triggered manually",
        "timestamp": time.Now().UTC().Format(time.RFC3339),
    })
}

func (cs *CronService) manualDLMMManageTrigger(w http.ResponseWriter, r *http.Request) {
    if r.Method != "POST" {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }
    cs.logger.Info("🔧 Manual DLMM manage trigger")
    cs.runDLMMManage()
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]string{
        "message":   "DLMM manage triggered manually",
        "timestamp": time.Now().UTC().Format(time.RFC3339),
    })
}

func parseOptionalRFC3339(s string) *time.Time {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t, err = time.Parse(time.RFC3339Nano, s)
		if err != nil {
			return nil
		}
	}
	utc := t.UTC()
	return &utc
}

func (cs *CronService) hydrateWorkerRuntime() {
	url := fmt.Sprintf(
		"%s/api/workers/runtime?key=%s",
		cs.config.APIBaseURL,
		cs.config.TrendingSecret,
	)
	body, err := cs.makeRequest("GET", url, nil, 15)
	if err != nil {
		cs.logger.Info(fmt.Sprintf("Worker runtime hydrate skipped: %v", err))
		return
	}

	var payload struct {
		Success bool `json:"success"`
		Workers []struct {
			WorkerID      string `json:"worker_id"`
			LastStartedAt string `json:"last_started_at"`
			LastSuccessAt string `json:"last_success_at"`
			LastErrorAt   string `json:"last_error_at"`
			LastErrorMsg  string `json:"last_error_msg"`
		} `json:"workers"`
	}
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		cs.logger.Info(fmt.Sprintf("Worker runtime hydrate parse failed: %v", err))
		return
	}
	if !payload.Success {
		return
	}

	hydrated := 0
	for _, row := range payload.Workers {
		if strings.TrimSpace(row.WorkerID) == "" {
			continue
		}
		cs.workers.Hydrate(row.WorkerID, WorkerRuntimeHydrate{
			LastStartedAt: parseOptionalRFC3339(row.LastStartedAt),
			LastSuccessAt: parseOptionalRFC3339(row.LastSuccessAt),
			LastErrorAt:   parseOptionalRFC3339(row.LastErrorAt),
			LastErrorMsg:  row.LastErrorMsg,
		})
		hydrated++
	}
	cs.logger.Info(fmt.Sprintf("Hydrated worker runtime for %d workers from Postgres", hydrated))
}

func (cs *CronService) persistWorkerRuntimeEvent(workerID, event, msg string) {
	url := fmt.Sprintf(
		"%s/api/workers/runtime?key=%s",
		cs.config.APIBaseURL,
		cs.config.TrendingSecret,
	)
	payload := map[string]interface{}{
		"worker_id": workerID,
		"event":     event,
		"at":        time.Now().UTC().Format(time.RFC3339),
	}
	if event == "fail" && msg != "" {
		payload["error_msg"] = msg
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}

	client := &http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequest("POST", url, bytes.NewReader(data))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "reloadsol-cron-service/1.0")
	resp, err := client.Do(req)
	if err != nil {
		cs.logger.Info(fmt.Sprintf("Worker runtime persist failed (%s/%s): %v", workerID, event, err))
		return
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode >= 300 {
		cs.logger.Info(fmt.Sprintf(
			"Worker runtime persist HTTP %d (%s/%s)",
			resp.StatusCode, workerID, event,
		))
	}
}

func (cs *CronService) makeRequest(method, url string, params map[string]string, timeoutSec ...int) (string, error) {
	// Add query parameters
	if len(params) > 0 {
		url += "?"
		for key, value := range params {
			url += fmt.Sprintf("%s=%s&", key, value)
		}
		url = url[:len(url)-1] // Remove trailing &
	}

	timeout := 30 * time.Second
	if len(timeoutSec) > 0 && timeoutSec[0] > 0 {
		timeout = time.Duration(timeoutSec[0]) * time.Second
	}

	client := &http.Client{Timeout: timeout}
	
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}

    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("User-Agent", "reloadsol-cron-service/1.0")
    if strings.Contains(url, "/api/pnl/update") {
        token := os.Getenv("PNL_UPDATE_SECRET")
        if token == "" {
            token = os.Getenv("PNL_UPDATE_TOKEN")
        }
        if token != "" {
            req.Header.Set("Authorization", "Bearer "+token)
        }
    }

	cs.logger.Info(fmt.Sprintf("Making %s request to %s", method, url))

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode >= 400 {
		errMsg := string(body)
		var parsed map[string]interface{}
		if json.Unmarshal(body, &parsed) == nil {
			if msg, ok := parsed["message"].(string); ok && msg != "" {
				errMsg = msg
			} else if errField, ok := parsed["error"].(string); ok && errField != "" {
				errMsg = errField
			}
		}
		return "", fmt.Errorf("API error %d: %s", resp.StatusCode, errMsg)
	}

	return string(body), nil
}

// getRandomMetricVariation returns a random variation between -5% and +5%
func getRandomMetricVariation(baseValue float64) float64 {
	variation := (rand.Float64() * 0.1) - 0.05 // Random between -0.05 and 0.05
	return baseValue * (1 + variation)
}

// Health check endpoint with enhanced metrics and random variations
func (cs *CronService) healthCheck(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	
	// Get cron entries for next execution times
	cs.workers.SyncNextRuns(cs.cron.Entries())
	workerSnapshot := cs.workers.Snapshot()

	// Gather real system metrics
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	memAlloc := float64(m.Alloc) / 1024 / 1024 // MB
	sysMem := float64(m.Sys) / 1024 / 1024     // MB
	goroutines := runtime.NumGoroutine()

	// CPU load (instantaneous, all cores)
	cpuPercents, err := cpu.Percent(0, false)
	var cpuLoad float64
	if err != nil || len(cpuPercents) == 0 {
		cpuLoad = -1 // Unable to obtain CPU load
	} else {
		cpuLoad = cpuPercents[0]
	}

	// Network latency to upstream API
	networkLatency := measureLatency(cs.config.APIBaseURL)

	// Simple health score calculation
	healthScore := 100.0
	if cpuLoad >= 0 {
		switch {
		case cpuLoad > 80:
			healthScore -= 20
		case cpuLoad > 60:
			healthScore -= 10
		}
	}
	switch {
	case memAlloc > 1024:
		healthScore -= 20
	case memAlloc > 512:
		healthScore -= 10
	}
	if networkLatency < 0 || networkLatency > 250 {
		healthScore -= 10
	}
	if healthScore < 0 {
		healthScore = 0
	}
	
	response := map[string]interface{}{
		"status":    "healthy",
		"timestamp": time.Now().UTC().Format(time.RFC3339),
		"service":   "reloadsol-cron-service",
		"version":   "1.0.0",
		"uptime":    time.Since(startTime).String(),
		"discord_enabled": cs.config.DiscordWebhook != "",
		"metrics": map[string]interface{}{
			"goroutines": goroutines,
			"memory": map[string]interface{}{
				"allocated_mb": memAlloc,
				"total_mb":    m.TotalAlloc / 1024 / 1024,
				"sys_mb":      sysMem,
			},
			"performance": map[string]interface{}{
				"cpu_load_percent": cpuLoad,
				"network_latency_ms": networkLatency,
				"health_score": healthScore,
			},
		},
		"cron_jobs": workerSnapshot,
		"workers_endpoint": "/workers",
	}
	
	// Log enhanced health check info with random variations
	healthInfo := fmt.Sprintf(
		"Health check - Status: %s, Goroutines: %d, Memory: %.1fMB, CPU: %.1f%%, Latency: %.0fms, Score: %.1f%%",
		response["status"],
		goroutines,
		memAlloc,
		cpuLoad,
		networkLatency,
		healthScore,
	)
	cs.logger.Info(healthInfo)
	
	// Send to Discord with more details every 5 minutes
	currentMinute := time.Now().Minute()
	if currentMinute%5 == 0 {
		staleCount := 0
		for _, w := range workerSnapshot {
			if status, ok := w["status"].(string); ok && (status == "stale" || status == "error") {
				staleCount++
			}
		}
		detailedInfo := fmt.Sprintf(`🏥 Health Check Report
Status: %s
Uptime: %s
Memory Usage: %.1f MB
Goroutines: %d
CPU Load: %.1f%%
Network Latency: %.0fms
Health Score: %.1f%%
Workers tracked: %d (stale/error: %d)
See /workers for full job status

Discord Integration: %v`,
			response["status"],
			response["uptime"],
			memAlloc,
			goroutines,
			cpuLoad,
			networkLatency,
			healthScore,
			len(workerSnapshot),
			staleCount,
			cs.config.DiscordWebhook != "",
		)
		
		cs.logger.SendImmediate(
			"🏥 Health Check Report",
			detailedInfo,
			3447003, // Blue
		)
	}
	
	json.NewEncoder(w).Encode(response)
}

// Status check with last execution times
func (cs *CronService) statusCheck(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	
	entries := cs.cron.Entries()
	
	response := map[string]interface{}{
		"status":       "running",
		"timestamp":    time.Now().UTC().Format(time.RFC3339),
		"cron_entries": len(entries),
		"discord_webhook_configured": cs.config.DiscordWebhook != "",
		"next_runs": map[string]string{
			"trending_tracker": "every 5 minutes",
			"daily_summary":    "daily at 00:00 UTC", 
			"pnl_update":       "daily at 02:00 UTC",
			"sltp_monitor":     fmt.Sprintf("every %d seconds", cs.config.SLTPMonitorInterval),
		},
		"config": map[string]string{
			"api_base_url": cs.config.APIBaseURL,
		},
	}
	
	cs.logger.Info("Status check requested")
	json.NewEncoder(w).Encode(response)
}

// Manual trigger endpoints for testing
func (cs *CronService) manualTrendingTrigger(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cs.logger.Info("🔧 Manual trending tracker trigger")
	cs.runTrendingTracker()
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"message": "Trending tracker triggered manually",
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
}

func (cs *CronService) manualSummaryTrigger(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cs.logger.Info("🔧 Manual summary trigger")
	cs.runDailySummary()
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"message": "Daily summary triggered manually",
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
}

func (cs *CronService) manualPnLTrigger(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cs.logger.Info("🔧 Manual PnL update trigger")
	cs.runPnLUpdate()
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"message": "PnL update triggered manually", 
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
}

// Test Discord logging endpoint
func (cs *CronService) testDiscordLogs(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cs.logger.Info("🧪 Testing Discord log integration...")
	cs.logger.Success("✅ Success message test")
	cs.logger.Warning("⚠️  Warning message test")
	cs.logger.Error("❌ Error message test")
	
	// Send immediate test notification
	cs.logger.SendImmediate(
		"🧪 Discord Integration Test",
		"This is a test of the Discord webhook integration. If you see this message, the integration is working correctly!",
		3447003, // Blue
	)
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"message": "Discord logging test completed",
		"timestamp": time.Now().UTC().Format(time.RFC3339),
		"webhook_configured": cs.config.DiscordWebhook != "",
		"webhook_url": func() string {
			if cs.config.DiscordWebhook != "" {
				// Show only the last part of the webhook for security
				parts := strings.Split(cs.config.DiscordWebhook, "/")
				if len(parts) > 2 {
					return ".../" + parts[len(parts)-2] + "/" + parts[len(parts)-1][:8] + "..."
				}
			}
			return "not configured"
		}(),
	})
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

// measureLatency performs a lightweight GET request to the provided target and returns
// the round-trip latency in milliseconds. It returns -1 if the request fails.
func measureLatency(target string) float64 {
    start := time.Now()
    client := &http.Client{Timeout: 5 * time.Second}
    req, err := http.NewRequest("GET", target, nil)
    if err != nil {
        return -1
    }
    req.Header.Set("User-Agent", "reloadsol-cron-service/latency-check")
    resp, err := client.Do(req)
    if err != nil {
        return -1
    }
    resp.Body.Close()
    return float64(time.Since(start).Milliseconds())
}

func main() {
	log.Println("🚀 reloadsol Cron Service Starting...")
	
	// Initialize random seed
	rand.Seed(time.Now().UnixNano())
	
	// Initialize start time
	startTime = time.Now()
	
	service := NewCronService()
	service.Start()
}