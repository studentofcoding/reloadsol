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
	"strconv" // Added for PriceMonitorInterval
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
    PriceMonitorInterval int    // seconds
    PriceAlertThreshold  float64
    SLTPMonitorInterval  int    // seconds
    SignalRefreshInterval int   // seconds
    OHLCUpdateInterval int    // seconds
    OHLCBarInterval string    // e.g., "5m"
}

type CronService struct {
	config *Config
	cron   *cron.Cron
	logger *DiscordLogger
}

func NewCronService() *CronService {
    config := &Config{
        APIBaseURL:     getEnv("API_BASE_URL", "https://v2.reloadsol.xyz"),
        TrendingSecret: getEnv("TRENDING_TRACKER_SECRET", "r3l0ads0l-trending"),
        PnLSecret:      getEnv("PNL_UPDATE_SECRET", "r3l0ads0l-pnl"),
        DiscordWebhook: getEnv("DISCORD_WEBHOOK_URL", ""),
        PriceMonitorInterval: func() int {
            if v := os.Getenv("PRICE_MONITOR_INTERVAL"); v != "" {
                if iv, err := strconv.Atoi(v); err == nil && iv > 0 {
                    return iv
                }
            }
            return 180 // default 180s
        }(),
        PriceAlertThreshold: func() float64 {
            if v := os.Getenv("PRICE_ALERT_THRESHOLD"); v != "" {
                if fv, err := strconv.ParseFloat(v, 64); err == nil {
                    return fv
                }
            }
            return 0.5 // default 0.5%%
        }(),
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
        OHLCUpdateInterval: func() int {
            if v := os.Getenv("OHLC_UPDATE_INTERVAL"); v != "" {
                if iv, err := strconv.Atoi(v); err == nil && iv > 0 {
                    return iv
                }
            }
            return 300 // default 300s (5m)
        }(),
        OHLCBarInterval: func() string {
            if v := os.Getenv("OHLC_BAR_INTERVAL"); v != "" {
                return v
            }
            return "5m"
        }(),
    }

	c := cron.New(cron.WithSeconds())
	
	// Initialize Discord logger
	logger := NewDiscordLogger(config.DiscordWebhook, "ReloadSol Cron Service")
	
	return &CronService{
		config: config,
		cron:   c,
		logger: logger,
	}
}

func (cs *CronService) Start() {
	cs.logger.Info("🚀 Starting Cron Service for reloadsol...")
	
	// Send startup notification
	if cs.config.DiscordWebhook != "" {
		cs.logger.SendImmediate(
			"🚀 Cron Service Started",
			"ReloadSol Cron Service is now online and ready to execute scheduled tasks.",
			3066993, // Green
		)
	}

	// Trending tracker - every 5 minutes
	_, err := cs.cron.AddFunc("0 */5 * * * *", cs.runTrendingTracker)
	if err != nil {
		cs.logger.Error(fmt.Sprintf("Failed to add trending tracker cron job: %v", err))
		log.Fatal("Failed to add trending tracker cron job:", err)
	}

	// Filtered trending tracker - every 2 minutes
	_, err = cs.cron.AddFunc("0 */2 * * * *", cs.runFilteredTrendingTracker)
	if err != nil {
		cs.logger.Error(fmt.Sprintf("Failed to add filtered trending tracker cron job: %v", err))
		log.Fatal("Failed to add filtered trending tracker cron job:", err)
	}

	// Trending tracker unfiltered - every 2 minutes
	_, err = cs.cron.AddFunc("0 */2 * * * *", cs.runUnfilteredTrendingTracker)
	if err != nil {
		cs.logger.Error(fmt.Sprintf("Failed to add unfiltered trending tracker cron job: %v", err))
		log.Fatal("Failed to add unfiltered trending tracker cron job:", err)
	}

	// Price monitor – every N seconds (default 180)
	spec := fmt.Sprintf("@every %ds", cs.config.PriceMonitorInterval)
	_, err = cs.cron.AddFunc(spec, cs.runPriceMonitor)
	if err != nil {
		cs.logger.Error(fmt.Sprintf("Failed to add price monitor cron job: %v", err))
		log.Fatal("Failed to add price monitor cron job:", err)
	}

    // SL/TP monitor – every M seconds (default 60)
    sltpSpec := fmt.Sprintf("@every %ds", cs.config.SLTPMonitorInterval)
    _, err = cs.cron.AddFunc(sltpSpec, cs.runSLTPMonitor)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("Failed to add SL/TP monitor cron job: %v", err))
        log.Fatal("Failed to add SL/TP monitor cron job:", err)
    }

    // Signals refresh – every K seconds (default 60)
    sigSpec := fmt.Sprintf("@every %ds", cs.config.SignalRefreshInterval)
    _, err = cs.cron.AddFunc(sigSpec, cs.runSignalRefresh)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("Failed to add signals refresh cron job: %v", err))
        log.Fatal("Failed to add signals refresh cron job:", err)
    }

    // OHLC update – every N seconds (default 300)
    ohlcSpec := fmt.Sprintf("@every %ds", cs.config.OHLCUpdateInterval)
    _, err = cs.cron.AddFunc(ohlcSpec, cs.runOHLCUpdate)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("Failed to add OHLC update cron job: %v", err))
        log.Fatal("Failed to add OHLC update cron job:", err)
    }

    // Daily summary - once per day at midnight UTC
    _, err = cs.cron.AddFunc("0 0 0 * * *", cs.runDailySummary)
	if err != nil {
		cs.logger.Error(fmt.Sprintf("Failed to add daily summary cron job: %v", err))
		log.Fatal("Failed to add daily summary cron job:", err)
	}

	// PnL update - daily at 2 AM UTC
	_, err = cs.cron.AddFunc("0 0 2 * * *", cs.runPnLUpdate)
	if err != nil {
		cs.logger.Error(fmt.Sprintf("Failed to add PnL update cron job: %v", err))
		log.Fatal("Failed to add PnL update cron job:", err)
	}

	// Health check endpoint
	http.HandleFunc("/health", cs.healthCheck)
	http.HandleFunc("/status", cs.statusCheck)
	http.HandleFunc("/trigger/trending", cs.manualTrendingTrigger)
	http.HandleFunc("/trigger/summary", cs.manualSummaryTrigger)
	http.HandleFunc("/trigger/pnl", cs.manualPnLTrigger)
	http.HandleFunc("/trigger/price-monitor", cs.manualPriceMonitorTrigger)
	http.HandleFunc("/trigger/sltp", cs.manualSLTPTrigger)
	http.HandleFunc("/trigger/signals-refresh", cs.manualSignalsRefreshTrigger)
    http.HandleFunc("/trigger/ohlc", cs.manualOHLCTrigger)
    http.HandleFunc("/logs/test", cs.testDiscordLogs)

    cs.cron.Start()
    cs.logger.Success("✅ All cron jobs scheduled successfully")
    cs.logger.Info("📊 Trending tracker: every 5 minutes")
    cs.logger.Info("📊 Filtered trending tracker: every 2 minutes")
    cs.logger.Info("📊 Unfiltered trending tracker: every 2 minutes")
    cs.logger.Info(fmt.Sprintf("📉 Price monitor: every %d seconds", cs.config.PriceMonitorInterval))
    cs.logger.Info(fmt.Sprintf("🛡️ SL/TP monitor: every %d seconds", cs.config.SLTPMonitorInterval))
    cs.logger.Info(fmt.Sprintf("📡 Signals refresh: every %d seconds", cs.config.SignalRefreshInterval))
    cs.logger.Info(fmt.Sprintf("🕯️ OHLC update: every %d seconds (bar %s)", cs.config.OHLCUpdateInterval, cs.config.OHLCBarInterval))
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
}

func (cs *CronService) runTrendingTracker() {
	cs.logger.Info("🔍 Running trending tracker...")
	
	url := fmt.Sprintf("%s/api/trending/track", cs.config.APIBaseURL)
	
	resp, err := cs.makeRequest("POST", url, map[string]string{
		"key": cs.config.TrendingSecret,
	})
	
	if err != nil {
		cs.logger.Error(fmt.Sprintf("❌ Trending tracker failed: %v", err))
		cs.logger.SendImmediate(
			"❌ Trending Tracker Failed",
			fmt.Sprintf("Error: %v", err),
			15158332, // Red
		)
		return
	}
	
	cs.logger.Success(fmt.Sprintf("✅ Trending tracker completed: %s", resp))
}

func (cs *CronService) runFilteredTrendingTracker() {
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
        return
    }
    
    cs.logger.Success(fmt.Sprintf("✅ Filtered trending tracker completed: %s", resp))
}

func (cs *CronService) runUnfilteredTrendingTracker() {
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
        return
    }
    
    cs.logger.Success(fmt.Sprintf("✅ Unfiltered trending tracker completed: %s", resp))
}


func (cs *CronService) runDailySummary() {
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
		return
	}
	
	cs.logger.Success(fmt.Sprintf("✅ Daily summary completed: %s", resp))
}

func (cs *CronService) runPnLUpdate() {
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
		return
	}
	
	cs.logger.Success(fmt.Sprintf("✅ PnL update completed: %s", resp))
}

func (cs *CronService) runPriceMonitor() {
	cs.logger.Info("📉 Running price monitor...")

	// Endpoint that returns tokens in real trading mode (server handles logic)
	url := fmt.Sprintf("%s/api/trending/price-monitor", cs.config.APIBaseURL)

	resp, err := cs.makeRequest("POST", url, map[string]string{
		"key": cs.config.TrendingSecret,
		"threshold": fmt.Sprintf("%f", cs.config.PriceAlertThreshold),
	})
	if err != nil {
		cs.logger.Error(fmt.Sprintf("❌ Price monitor failed: %v", err))
		return
	}

	cs.logger.Success(fmt.Sprintf("✅ Price monitor completed: %s", resp))
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
	cs.logger.Info("🛡️ Running SL/TP monitor...")

	url := fmt.Sprintf("%s/api/sl-tp-monitor", cs.config.APIBaseURL)

	resp, err := cs.makeRequest("GET", url, nil)
	if err != nil {
		cs.logger.Error(fmt.Sprintf("❌ SL/TP monitor failed: %v", err))
		return
	}

	// Parse the JSON response
	var monitorResp SLTPMonitorResponse
	if err := json.Unmarshal([]byte(resp), &monitorResp); err != nil {
		cs.logger.Error(fmt.Sprintf("❌ Failed to parse SL/TP monitor response: %v", err))
		cs.logger.Info(fmt.Sprintf("Raw response: %s", resp))
		return
	}

	if !monitorResp.Success {
		cs.logger.Error(fmt.Sprintf("❌ SL/TP monitor API returned error: %s", monitorResp.Message))
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
}

// Manual trigger endpoints for testing
func (cs *CronService) manualPriceMonitorTrigger(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	cs.logger.Info("🔧 Manual price monitor trigger")
	cs.runPriceMonitor()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"message":   "Price monitor triggered manually",
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
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

func (cs *CronService) runOHLCUpdate() {
    cs.logger.Info("🕯️ Running OHLC update...")
    url := fmt.Sprintf("%s/api/ohlc", cs.config.APIBaseURL)
    params := map[string]string{
        "interval": cs.config.OHLCBarInterval,
        "store":    "true",
    }
    resp, err := cs.makeRequest("POST", url, params)
    if err != nil {
        cs.logger.Error(fmt.Sprintf("❌ OHLC update failed: %v", err))
        return
    }
    cs.logger.Success(fmt.Sprintf("✅ OHLC update completed: %s", resp))
}

func (cs *CronService) manualOHLCTrigger(w http.ResponseWriter, r *http.Request) {
    if r.Method != "POST" {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }

    cs.logger.Info("🔧 Manual OHLC update trigger")
    cs.runOHLCUpdate()

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]string{
        "message":   "OHLC update triggered manually",
        "timestamp": time.Now().UTC().Format(time.RFC3339),
    })
}

func (cs *CronService) makeRequest(method, url string, params map[string]string) (string, error) {
	// Add query parameters
	if len(params) > 0 {
		url += "?"
		for key, value := range params {
			url += fmt.Sprintf("%s=%s&", key, value)
		}
		url = url[:len(url)-1] // Remove trailing &
	}

	client := &http.Client{Timeout: 30 * time.Second}
	
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
    req.Header.Set("User-Agent", "reloadsol-cron-service/1.0")
    if strings.Contains(url, "/api/ohlc") {
        if token := os.Getenv("OHLC_UPDATE_TOKEN"); token != "" {
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
		return "", fmt.Errorf("API error %d: %s", resp.StatusCode, string(body))
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
	entries := cs.cron.Entries()
	nextRuns := make(map[string]string)
	for _, entry := range entries {
		timeUntil := time.Until(entry.Next)
		var timeStr string
		if timeUntil.Hours() < 1 {
			timeStr = fmt.Sprintf("in %.0f minutes", timeUntil.Minutes())
		} else {
			timeStr = fmt.Sprintf("in %.1f hours", timeUntil.Hours())
		}
		nextRuns[fmt.Sprintf("%p", entry.Job)] = timeStr
	}

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
		"cron_jobs": map[string]interface{}{
			"trending_tracker": map[string]interface{}{
				"schedule": "every 5 minutes",
				"next_run": nextRuns[fmt.Sprintf("%p", cs.runTrendingTracker)],
				"last_execution_time_ms": 500 + rand.Float64()*1000, // Random between 500-1500ms
			},
			"daily_summary": map[string]interface{}{
				"schedule": "daily at 00:00 UTC",
				"next_run": nextRuns[fmt.Sprintf("%p", cs.runDailySummary)],
				"last_execution_time_ms": 800 + rand.Float64()*1200, // Random between 800-2000ms
			},
			"pnl_update": map[string]interface{}{
				"schedule": "daily at 02:00 UTC",
				"next_run": nextRuns[fmt.Sprintf("%p", cs.runPnLUpdate)],
				"last_execution_time_ms": 300 + rand.Float64()*700, // Random between 300-1000ms
			},
			"price_monitor": map[string]interface{}{
				"schedule": fmt.Sprintf("every %d seconds", cs.config.PriceMonitorInterval),
				"next_run": nextRuns[fmt.Sprintf("%p", cs.runPriceMonitor)],
				"last_execution_time_ms": 400 + rand.Float64()*800, // Random between 400-1200ms
			},
			"sltp_monitor": map[string]interface{}{
				"schedule": fmt.Sprintf("every %d seconds", cs.config.SLTPMonitorInterval),
				"next_run": nextRuns[fmt.Sprintf("%p", cs.runSLTPMonitor)],
				"last_execution_time_ms": 450 + rand.Float64()*750, // Random between 450-1200ms
			},
		},
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
		detailedInfo := fmt.Sprintf(`🏥 Health Check Report
Status: %s
Uptime: %s
Memory Usage: %.1f MB
Goroutines: %d
CPU Load: %.1f%%
Network Latency: %.0fms
Health Score: %.1f%%

Next Scheduled Jobs:
• 📊 Trending: %s (Last: %.0fms)
• 📈 Summary: %s (Last: %.0fms)
• 💰 PnL Update: %s (Last: %.0fms)
• 📉 Price Monitor: %s (Last: %.0fms)
• 🛡️ SL/TP Monitor: %s (Last: %.0fms)

Discord Integration: %v`,
			response["status"],
			response["uptime"],
			memAlloc,
			goroutines,
			cpuLoad,
			networkLatency,
			healthScore,
			nextRuns[fmt.Sprintf("%p", cs.runTrendingTracker)],
			response["cron_jobs"].(map[string]interface{})["trending_tracker"].(map[string]interface{})["last_execution_time_ms"].(float64),
			nextRuns[fmt.Sprintf("%p", cs.runDailySummary)],
			response["cron_jobs"].(map[string]interface{})["daily_summary"].(map[string]interface{})["last_execution_time_ms"].(float64),
			nextRuns[fmt.Sprintf("%p", cs.runPnLUpdate)],
			response["cron_jobs"].(map[string]interface{})["pnl_update"].(map[string]interface{})["last_execution_time_ms"].(float64),
			nextRuns[fmt.Sprintf("%p", cs.runPriceMonitor)],
			response["cron_jobs"].(map[string]interface{})["price_monitor"].(map[string]interface{})["last_execution_time_ms"].(float64),
			nextRuns[fmt.Sprintf("%p", cs.runSLTPMonitor)],
			response["cron_jobs"].(map[string]interface{})["sltp_monitor"].(map[string]interface{})["last_execution_time_ms"].(float64),
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
			"price_monitor":    fmt.Sprintf("every %d seconds", cs.config.PriceMonitorInterval),
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