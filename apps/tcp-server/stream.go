package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"fleet-vision/tcp-server/parser"
)

// StreamClient represents an active SSE client listener.
type StreamClient struct {
	ch         chan []byte
	filterIMEI string // Empty string means receive all vehicles
}

// StreamHub manages active SSE listeners and caches the latest telemetry packet per device.
type StreamHub struct {
	clients      map[chan []byte]StreamClient
	mu           sync.RWMutex
	latestCache  map[string]json.RawMessage
	cacheMu      sync.RWMutex
	totalPackets uint64
	startTime    time.Time
}

var hub = &StreamHub{
	clients:     make(map[chan []byte]StreamClient),
	latestCache: make(map[string]json.RawMessage),
	startTime:   time.Now(),
}

// Register adds a new client channel to the hub.
func (h *StreamHub) Register(ch chan []byte, filterIMEI string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[ch] = StreamClient{
		ch:         ch,
		filterIMEI: filterIMEI,
	}
	log.Printf("[STREAM] New client connected (filter=%q). Total listeners: %d", filterIMEI, len(h.clients))
}

// Unregister removes a client channel.
func (h *StreamHub) Unregister(ch chan []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.clients, ch)
	close(ch)
	log.Printf("[STREAM] Client disconnected. Total listeners: %d", len(h.clients))
}

// Broadcast sends a JSON payload to all matching SSE clients and updates the latest cache.
func (h *StreamHub) Broadcast(msg []byte, imei string) {
	atomic.AddUint64(&h.totalPackets, 1)

	// Update latest cache for fast polling (/latest)
	h.cacheMu.Lock()
	h.latestCache[imei] = json.RawMessage(msg)
	h.cacheMu.Unlock()

	// Broadcast to connected SSE listeners
	h.mu.RLock()
	defer h.mu.RUnlock()
	for ch, client := range h.clients {
		if client.filterIMEI != "" && client.filterIMEI != imei {
			continue // Skip client if filtering for a different IMEI
		}
		select {
		case ch <- msg:
		default:
			// Non-blocking: skip if client buffer is full to prevent lagging slow clients
		}
	}
}

// handleStream handles GET /stream (Server-Sent Events).
// Accepts optional ?imei= query parameter to filter by device.
func handleStream(w http.ResponseWriter, r *http.Request) {
	// Enable CORS so local apps/dashboards can connect from anywhere
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported by client", http.StatusInternalServerError)
		return
	}

	filterIMEI := r.URL.Query().Get("imei")

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // Disable Nginx proxy buffering

	clientChan := make(chan []byte, 100)
	hub.Register(clientChan, filterIMEI)
	defer hub.Unregister(clientChan)

	// Send initial connection event
	fmt.Fprintf(w, ": connected to Fleet Vision remote TCP stream (filter=%q)\n\n", filterIMEI)
	flusher.Flush()

	notify := r.Context().Done()
	for {
		select {
		case <-notify:
			return
		case msg := <-clientChan:
			fmt.Fprintf(w, "data: %s\n\n", msg)
			flusher.Flush()
		}
	}
}

// handleLatest handles GET /latest.
// Returns the most recently received packet for all devices, or for ?imei=...
func handleLatest(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")

	filterIMEI := r.URL.Query().Get("imei")

	hub.cacheMu.RLock()
	defer hub.cacheMu.RUnlock()

	if filterIMEI != "" {
		msg, exists := hub.latestCache[filterIMEI]
		if !exists {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(fmt.Sprintf(`{"error":"No telemetry yet for IMEI %s"}`, filterIMEI)))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(msg)
		return
	}

	response := map[string]interface{}{
		"device_count": len(hub.latestCache),
		"devices":      hub.latestCache,
		"timestamp":    time.Now().UTC().Format(time.RFC3339),
	}
	_ = json.NewEncoder(w).Encode(response)
}

// handleHealth handles GET /healthz with service health and real-time streaming stats.
func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")

	hub.mu.RLock()
	activeListeners := len(hub.clients)
	hub.mu.RUnlock()

	hub.cacheMu.RLock()
	activeDevices := len(hub.latestCache)
	hub.cacheMu.RUnlock()

	stats := map[string]interface{}{
		"status":                 "ok",
		"service":                "tcp-server",
		"active_listeners":       activeListeners,
		"active_devices_tracked": activeDevices,
		"total_packets_received": atomic.LoadUint64(&hub.totalPackets),
		"uptime_seconds":         int(time.Since(hub.startTime).Seconds()),
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(stats)
}

// buildTelemetryMessage builds the full envelope containing decoded records and raw hex.
func buildTelemetryMessage(imei string, avlPacket *parser.AVLPacket, rawData []byte) ([]byte, error) {
	codecName := "codec8"
	if avlPacket.CodecID == parser.CodecID8E {
		codecName = "codec8e"
	}

	msg := parser.TelemetryMessage{
		IMEI:            imei,
		Records:         avlPacket.Records,
		Codec:           codecName,
		ServerTimestamp: time.Now().UTC().Format(time.RFC3339Nano),
		RawHex:          hex.EncodeToString(rawData),
	}

	return json.Marshal(msg)
}
