package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

type fomoWsMsg struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

type fomoHello struct {
	LagSeconds *float64 `json:"lag_seconds"`
	LastBlock  *int64   `json:"last_block"`
	Viewers    *int     `json:"viewers"`
}

type fomoIngestBody struct {
	Fills []json.RawMessage `json:"fills"`
	Hello json.RawMessage   `json:"hello,omitempty"`
}

type fomoIngestResp struct {
	Success    bool   `json:"success"`
	LastFillID *int64 `json:"last_fill_id"`
	Error      string `json:"error"`
}

type fomoHealthResp struct {
	Success    bool     `json:"success"`
	LastFillID int64    `json:"last_fill_id"`
	LagSeconds *float64 `json:"lag_seconds"`
}

func envBool(key string, fallback bool) bool {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	switch strings.ToLower(v) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

func envInt(key string, fallback int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return fallback
	}
	return n
}

func (cs *CronService) fomoIngestURL() string {
	return strings.TrimRight(cs.config.APIBaseURL, "/") + "/api/fomo/ingest"
}

func (cs *CronService) fomoRestBase() string {
	return strings.TrimRight(getEnv("FOMO_REST_BASE", "https://robinhoodtrenches.com"), "/")
}

func (cs *CronService) fomoAuthHeader() string {
	if cs.config.TrendingSecret == "" {
		return ""
	}
	return "Bearer " + cs.config.TrendingSecret
}

func (cs *CronService) fomoHTTPGet(url string, timeout time.Duration) ([]byte, error) {
	client := &http.Client{Timeout: timeout}
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "reloadsol-cron-service/1.0")
	if auth := cs.fomoAuthHeader(); auth != "" && strings.Contains(url, "/api/fomo/") {
		req.Header.Set("Authorization", auth)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body))
	}
	return body, nil
}

func (cs *CronService) postFomoIngest(fills []json.RawMessage, hello json.RawMessage) (int64, error) {
	if len(fills) == 0 && len(hello) == 0 {
		return 0, nil
	}
	capN := envInt("FOMO_MAX_FILLS_PER_BATCH", 100)
	if capN <= 0 {
		capN = 100
	}
	var lastID int64
	for i := 0; i < len(fills) || (i == 0 && len(hello) > 0); {
		end := i + capN
		if end > len(fills) {
			end = len(fills)
		}
		chunk := fomoIngestBody{}
		if i < len(fills) {
			chunk.Fills = fills[i:end]
		}
		if i == 0 && len(hello) > 0 {
			chunk.Hello = hello
		}
		payload, err := json.Marshal(chunk)
		if err != nil {
			return lastID, err
		}
		req, err := http.NewRequest("POST", cs.fomoIngestURL(), bytes.NewReader(payload))
		if err != nil {
			return lastID, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "reloadsol-cron-service/1.0")
		if auth := cs.fomoAuthHeader(); auth != "" {
			req.Header.Set("Authorization", auth)
		}
		client := &http.Client{Timeout: 30 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			return lastID, err
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode >= 400 {
			return lastID, fmt.Errorf("ingest HTTP %d: %s", resp.StatusCode, string(body))
		}
		var parsed fomoIngestResp
		if err := json.Unmarshal(body, &parsed); err != nil {
			return lastID, err
		}
		if !parsed.Success {
			return lastID, fmt.Errorf("ingest: %s", parsed.Error)
		}
		if parsed.LastFillID != nil && *parsed.LastFillID > lastID {
			lastID = *parsed.LastFillID
		}
		if i >= len(fills) {
			break
		}
		i = end
		if i >= len(fills) {
			break
		}
	}
	return lastID, nil
}

func parseTapeFills(body []byte) []json.RawMessage {
	var arr []json.RawMessage
	if err := json.Unmarshal(body, &arr); err == nil && len(arr) > 0 {
		return arr
	}
	var wrap map[string]json.RawMessage
	if err := json.Unmarshal(body, &wrap); err != nil {
		return nil
	}
	for _, key := range []string{"data", "fills", "rows"} {
		raw, ok := wrap[key]
		if !ok {
			continue
		}
		var inner []json.RawMessage
		if json.Unmarshal(raw, &inner) == nil {
			return inner
		}
	}
	return nil
}

func fillID(raw json.RawMessage) int64 {
	var row struct {
		ID int64 `json:"id"`
	}
	if json.Unmarshal(raw, &row) != nil {
		return 0
	}
	return row.ID
}

func (cs *CronService) fomoGapFill(lastID int64) (int64, error) {
	body, err := cs.fomoHTTPGet(cs.fomoRestBase()+"/api/tape?limit=400", 20*time.Second)
	if err != nil {
		return lastID, err
	}
	var newer []json.RawMessage
	maxID := lastID
	for _, raw := range parseTapeFills(body) {
		id := fillID(raw)
		if id <= lastID {
			continue
		}
		newer = append(newer, raw)
		if id > maxID {
			maxID = id
		}
	}
	if len(newer) == 0 {
		return lastID, nil
	}
	posted, err := cs.postFomoIngest(newer, nil)
	if err != nil {
		return lastID, err
	}
	if posted > maxID {
		return posted, nil
	}
	return maxID, nil
}

func (cs *CronService) fomoHealthLastID() int64 {
	body, err := cs.fomoHTTPGet(cs.fomoIngestURL(), 10*time.Second)
	if err != nil {
		return 0
	}
	var parsed fomoHealthResp
	if json.Unmarshal(body, &parsed) != nil || !parsed.Success {
		return 0
	}
	return parsed.LastFillID
}

func (cs *CronService) runFomoWsLoop() {
	reconnect := time.Duration(envInt("FOMO_WS_RECONNECT_MS", 2500)) * time.Millisecond
	if reconnect < 500*time.Millisecond {
		reconnect = 2500 * time.Millisecond
	}
	for {
		cs.workers.Begin("fomo_ws")
		err := cs.runFomoWsSession()
		if err != nil {
			cs.workers.Fail("fomo_ws", err.Error())
			cs.logger.Error(fmt.Sprintf("fomo_ws: %v", err))
		} else {
			cs.workers.Fail("fomo_ws", "websocket closed")
		}
		time.Sleep(reconnect)
	}
}

func (cs *CronService) runFomoWsSession() error {
	lastID := cs.fomoHealthLastID()
	filled, err := cs.fomoGapFill(lastID)
	if err != nil {
		cs.logger.Info(fmt.Sprintf("fomo_ws tape backfill: %v", err))
	} else {
		lastID = filled
	}

	wsURL := getEnv("FOMO_WS_URL", "wss://robinhoodtrenches.com/ws")
	conn, err := dialFomoWS(wsURL, 20*time.Second)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	keepalive := time.Duration(envInt("FOMO_WS_KEEPALIVE_MS", 20000)) * time.Millisecond
	if keepalive < time.Second {
		keepalive = 20 * time.Second
	}
	lagLimit := float64(envInt("FOMO_LAG_ALERT_SECONDS", 30))
	idle := keepalive * 3

	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(keepalive)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				_ = conn.WriteText([]byte("p"))
			}
		}
	}()
	defer close(done)

	cs.logger.Info("fomo_ws: connected")
	cs.workers.Success("fomo_ws")

	for {
		_ = conn.SetReadDeadline(time.Now().Add(idle))
		payload, err := conn.ReadText()
		if err != nil {
			return err
		}
		var msg fomoWsMsg
		if json.Unmarshal(payload, &msg) != nil {
			continue
		}
		switch msg.Type {
		case "hello":
			var hello fomoHello
			_ = json.Unmarshal(msg.Data, &hello)
			if hello.LagSeconds != nil && lagLimit > 0 && *hello.LagSeconds > lagLimit {
				_, _ = cs.postFomoIngest(nil, msg.Data)
				return fmt.Errorf("indexer lag_seconds %.1f > %.0f", *hello.LagSeconds, lagLimit)
			}
			if _, err := cs.postFomoIngest(nil, msg.Data); err != nil {
				return err
			}
			cs.workers.Success("fomo_ws")
		case "fills":
			var fills []json.RawMessage
			if json.Unmarshal(msg.Data, &fills) != nil {
				continue
			}
			var newer []json.RawMessage
			for _, raw := range fills {
				id := fillID(raw)
				if id <= lastID {
					continue
				}
				newer = append(newer, raw)
				if id > lastID {
					lastID = id
				}
			}
			if len(newer) == 0 {
				continue
			}
			posted, err := cs.postFomoIngest(newer, nil)
			if err != nil {
				return err
			}
			if posted > lastID {
				lastID = posted
			}
			cs.workers.Success("fomo_ws")
		}
	}
}

func (cs *CronService) manualFomoWsTrigger(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":   true,
		"message":   "fomo_ws is an always-on goroutine; toggle FOMO_WS_ENABLED and restart cron",
		"enabled":   cs.config.FomoWsEnabled,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
}
