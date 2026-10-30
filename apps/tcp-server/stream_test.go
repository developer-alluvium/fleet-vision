package main

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"fleet-vision/tcp-server/parser"
)

func TestStreamHub_BroadcastAndStream(t *testing.T) {
	// 1. Create a test HTTP server with /stream and /latest
	mux := http.NewServeMux()
	mux.HandleFunc("/stream", handleStream)
	mux.HandleFunc("/latest", handleLatest)
	mux.HandleFunc("/healthz", handleHealth)
	server := httptest.NewServer(mux)
	defer server.Close()

	// 2. Connect client to /stream
	resp, err := http.Get(server.URL + "/stream")
	if err != nil {
		t.Fatalf("Failed to connect to /stream: %v", err)
	}
	defer resp.Body.Close()

	reader := bufio.NewReader(resp.Body)

	// Read initial greeting event
	line, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("Failed to read stream header: %v", err)
	}
	if !strings.HasPrefix(line, ": connected") {
		t.Errorf("Expected greeting, got: %s", line)
	}
	// Consume empty line after greeting
	_, _ = reader.ReadString('\n')

	// 3. Broadcast test telemetry message
	testIMEI := "864209041234567"
	samplePacket := &parser.AVLPacket{
		CodecID:     parser.CodecID8E,
		RecordCount: 1,
		Records: []parser.AVLRecord{
			{
				Timestamp:  time.Now().UTC(),
				Priority:   1,
				Longitude:  77.2090,
				Latitude:   28.6139,
				Altitude:   215,
				Angle:      45,
				Satellites: 12,
				Speed:      55,
				IOElements: map[string]uint64{"ignition": 1},
			},
		},
	}
	fakeRaw := []byte{0x08, 0x01, 0x00}
	jsonBytes, err := buildTelemetryMessage(testIMEI, samplePacket, fakeRaw)
	if err != nil {
		t.Fatalf("buildTelemetryMessage error: %v", err)
	}

	// Trigger broadcast in background
	go func() {
		time.Sleep(50 * time.Millisecond)
		hub.Broadcast(jsonBytes, testIMEI)
	}()

	// 4. Read broadcasted event from /stream
	dataLine, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("Failed to read broadcast data: %v", err)
	}
	if !strings.HasPrefix(dataLine, "data: ") {
		t.Fatalf("Expected 'data: ' prefix, got: %s", dataLine)
	}

	payload := strings.TrimPrefix(strings.TrimSpace(dataLine), "data: ")
	var msg parser.TelemetryMessage
	if err := json.Unmarshal([]byte(payload), &msg); err != nil {
		t.Fatalf("Failed to unmarshal stream data: %v", err)
	}

	if msg.IMEI != testIMEI {
		t.Errorf("Expected IMEI %s, got %s", testIMEI, msg.IMEI)
	}
	if len(msg.Records) != 1 || msg.Records[0].Speed != 55 {
		t.Errorf("Record speed mismatch, got: %+v", msg.Records)
	}

	// 5. Test /latest endpoint
	latestResp, err := http.Get(server.URL + "/latest?imei=" + testIMEI)
	if err != nil {
		t.Fatalf("Failed to call /latest: %v", err)
	}
	defer latestResp.Body.Close()

	if latestResp.StatusCode != http.StatusOK {
		t.Fatalf("Expected 200 from /latest, got %d", latestResp.StatusCode)
	}

	var latestMsg parser.TelemetryMessage
	if err := json.NewDecoder(latestResp.Body).Decode(&latestMsg); err != nil {
		t.Fatalf("Failed to parse /latest JSON: %v", err)
	}
	if latestMsg.IMEI != testIMEI {
		t.Errorf("Expected /latest IMEI %s, got %s", testIMEI, latestMsg.IMEI)
	}

	// 6. Test /healthz endpoint
	healthResp, err := http.Get(server.URL + "/healthz")
	if err != nil {
		t.Fatalf("Failed to call /healthz: %v", err)
	}
	defer healthResp.Body.Close()

	var healthMap map[string]interface{}
	if err := json.NewDecoder(healthResp.Body).Decode(&healthMap); err != nil {
		t.Fatalf("Failed to parse /healthz JSON: %v", err)
	}
	if healthMap["status"] != "ok" {
		t.Errorf("Expected health status ok, got %v", healthMap["status"])
	}
}
