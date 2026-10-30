package main

import (
	"encoding/json"
	"fmt"
	"net/http"
)

// getOpenAPISpec returns the OpenAPI 3.0 specification for the TCP Server HTTP API.
func getOpenAPISpec(host string) map[string]interface{} {
	if host == "" {
		host = "localhost:8501"
	}
	serverURL := fmt.Sprintf("http://%s", host)

	return map[string]interface{}{
		"openapi": "3.0.0",
		"info": map[string]interface{}{
			"title":   "Fleet Vision · TCP Server & Telemetry Stream API",
			"version": "1.0.0",
			"description": "Interactive API reference for the Fleet Vision Go TCP Ingestion Gateway and Remote Telemetry Streaming service.\n\n" +
				"### Overview\n" +
				"- **Hardware Port (`TCP :8500`)**: Listens for Teltonika GPS tracker AVL binary frames (Codec 8 & Codec 8 Extended).\n" +
				"- **API Port (`HTTP :8501`)**: Provides real-time Server-Sent Events (SSE) telemetry broadcasts and JSON query endpoints for local/remote developers.\n\n" +
				"### Real-Time Streaming\n" +
				"The `/stream` endpoint uses **Server-Sent Events (SSE)**. You can connect using `curl -N`, standard browser `EventSource`, or any HTTP client to receive live vehicle telemetry.",
		},
		"servers": []map[string]interface{}{
			{
				"url":         serverURL,
				"description": "Current Server",
			},
			{
				"url":         "http://localhost:8501",
				"description": "Local Development",
			},
		},
		"tags": []map[string]interface{}{
			{
				"name":        "Telemetry Stream",
				"description": "Real-time Server-Sent Events (SSE) broadcasting incoming GPS records to listeners.",
			},
			{
				"name":        "Telemetry Snapshot",
				"description": "Instant snapshots and fast polling for the latest vehicle coordinates and IO data.",
			},
			{
				"name":        "Health & Diagnostics",
				"description": "Service operational health, active listeners, and throughput statistics.",
			},
		},
		"paths": map[string]interface{}{
			"/stream": map[string]interface{}{
				"get": map[string]interface{}{
					"tags":        []string{"Telemetry Stream"},
					"summary":     "Live Telemetry Stream (Server-Sent Events)",
					"description": "Subscribes to real-time incoming vehicle telemetry packets broadcast directly from the Teltonika TCP ingestion server. Pushes Server-Sent Events containing parsed AVL records and raw hex payload.",
					"parameters": []map[string]interface{}{
						{
							"name":        "imei",
							"in":          "query",
							"required":    false,
							"description": "Optional 15-digit hardware IMEI. If specified, only packets from this device will be streamed.",
							"schema": map[string]interface{}{
								"type":    "string",
								"example": "864209041234567",
							},
						},
					},
					"responses": map[string]interface{}{
						"200": map[string]interface{}{
							"description": "Continuous stream of Server-Sent Events (SSE). Each event starts with `data: ` followed by a JSON TelemetryMessage.",
							"content": map[string]interface{}{
								"text/event-stream": map[string]interface{}{
									"schema": map[string]interface{}{
										"$ref": "#/components/schemas/TelemetryMessage",
									},
								},
							},
						},
					},
				},
			},
			"/latest": map[string]interface{}{
				"get": map[string]interface{}{
					"tags":        []string{"Telemetry Snapshot"},
					"summary":     "Get Latest Telemetry Snapshot",
					"description": "Returns the most recent telemetry packet received for all active vehicles, or for a specific vehicle via query parameter.",
					"parameters": []map[string]interface{}{
						{
							"name":        "imei",
							"in":          "query",
							"required":    false,
							"description": "Optional 15-digit hardware IMEI. When provided, returns only the single latest packet for that device.",
							"schema": map[string]interface{}{
								"type":    "string",
								"example": "864209041234567",
							},
						},
					},
					"responses": map[string]interface{}{
						"200": map[string]interface{}{
							"description": "Latest telemetry data.",
							"content": map[string]interface{}{
								"application/json": map[string]interface{}{
									"schema": map[string]interface{}{
										"oneOf": []map[string]interface{}{
											{"$ref": "#/components/schemas/LatestAllResponse"},
											{"$ref": "#/components/schemas/TelemetryMessage"},
										},
									},
								},
							},
						},
						"404": map[string]interface{}{
							"description": "No telemetry found for the specified IMEI.",
							"content": map[string]interface{}{
								"application/json": map[string]interface{}{
									"example": map[string]string{"error": "No telemetry yet for IMEI 864209041234567"},
								},
							},
						},
					},
				},
			},
			"/healthz": map[string]interface{}{
				"get": map[string]interface{}{
					"tags":        []string{"Health & Diagnostics"},
					"summary":     "TCP Server Health & Streaming Metrics",
					"description": "Returns service health, count of active SSE stream listeners, tracked devices, total packets received, and uptime.",
					"responses": map[string]interface{}{
						"200": map[string]interface{}{
							"description": "Service is healthy and operating normally.",
							"content": map[string]interface{}{
								"application/json": map[string]interface{}{
									"schema": map[string]interface{}{
										"$ref": "#/components/schemas/HealthStatus",
									},
								},
							},
						},
					},
				},
			},
		},
		"components": map[string]interface{}{
			"schemas": map[string]interface{}{
				"TelemetryMessage": map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"imei": map[string]interface{}{
							"type":        "string",
							"description": "15-digit hardware IMEI number of the vehicle tracker",
							"example":     "864209041234567",
						},
						"codec": map[string]interface{}{
							"type":        "string",
							"description": "Teltonika codec used (codec8 or codec8e)",
							"example":     "codec8e",
						},
						"server_timestamp": map[string]interface{}{
							"type":        "string",
							"format":      "date-time",
							"description": "UTC timestamp when the packet arrived at the TCP gateway",
							"example":     "2026-10-30T15:00:00.000Z",
						},
						"raw_hex": map[string]interface{}{
							"type":        "string",
							"description": "Original raw hex bytes received over TCP socket",
							"example":     "000000000000003b8e010000018a...",
						},
						"records": map[string]interface{}{
							"type": "array",
							"items": map[string]interface{}{
								"$ref": "#/components/schemas/AVLRecord",
							},
						},
					},
				},
				"AVLRecord": map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"timestamp": map[string]interface{}{
							"type":        "string",
							"format":      "date-time",
							"description": "GPS satellite fix timestamp",
							"example":     "2026-10-30T14:59:55.000Z",
						},
						"priority": map[string]interface{}{
							"type":        "integer",
							"description": "Record priority (0=low, 1=high, 2=panic)",
							"example":     1,
						},
						"longitude": map[string]interface{}{
							"type":        "number",
							"format":      "double",
							"description": "WGS-84 longitude coordinate",
							"example":     77.209021,
						},
						"latitude": map[string]interface{}{
							"type":        "number",
							"format":      "double",
							"description": "WGS-84 latitude coordinate",
							"example":     28.613939,
						},
						"altitude": map[string]interface{}{
							"type":        "integer",
							"description": "Altitude in meters above sea level",
							"example":     215,
						},
						"angle": map[string]interface{}{
							"type":        "integer",
							"description": "Vehicle heading angle (0-359 degrees)",
							"example":     180,
						},
						"satellites": map[string]interface{}{
							"type":        "integer",
							"description": "Number of visible GPS satellites",
							"example":     14,
						},
						"speed": map[string]interface{}{
							"type":        "integer",
							"description": "Current ground speed in km/h",
							"example":     62,
						},
						"io_elements": map[string]interface{}{
							"type":        "object",
							"description": "Decoded IO sensor attributes (e.g. ignition, battery voltage, external power)",
							"example": map[string]interface{}{
								"ignition":       1,
								"battery_mv":     4120,
								"external_mv":    12400,
								"movement":       1,
								"gsm_signal":     4,
							},
						},
					},
				},
				"LatestAllResponse": map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"device_count": map[string]interface{}{
							"type":    "integer",
							"example": 2,
						},
						"devices": map[string]interface{}{
							"type": "object",
							"description": "Keyed by vehicle IMEI",
						},
						"timestamp": map[string]interface{}{
							"type":    "string",
							"format":  "date-time",
							"example": "2026-10-30T15:00:00Z",
						},
					},
				},
				"HealthStatus": map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"status": map[string]interface{}{
							"type":    "string",
							"example": "ok",
						},
						"service": map[string]interface{}{
							"type":    "string",
							"example": "tcp-server",
						},
						"active_listeners": map[string]interface{}{
							"type":        "integer",
							"description": "Count of concurrent developers listening to /stream",
							"example":     2,
						},
						"active_devices_tracked": map[string]interface{}{
							"type":        "integer",
							"description": "Count of distinct IMEIs tracked in memory",
							"example":     15,
						},
						"total_packets_received": map[string]interface{}{
							"type":        "integer",
							"description": "Total count of AVL packets processed since startup",
							"example":     14502,
						},
						"uptime_seconds": map[string]interface{}{
							"type":    "integer",
							"example": 86400,
						},
					},
				},
			},
		},
	}
}

// handleOpenAPI serves the OpenAPI 3.0 specification as JSON.
func handleOpenAPI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")
	spec := getOpenAPISpec(r.Host)
	_ = json.NewEncoder(w).Encode(spec)
}

// handleSwaggerUI serves the interactive Swagger UI page.
func handleSwaggerUI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	html := `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fleet Vision · TCP Gateway API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css" />
  <link rel="icon" type="image/png" href="https://unpkg.com/swagger-ui-dist@5.11.0/favicon-32x32.png" />
  <style>
    body { margin: 0; background: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .custom-bar {
      background: #0f172a;
      color: #ffffff;
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 3px solid #3b82f6;
    }
    .custom-bar h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .badge {
      background: rgba(59, 130, 246, 0.2);
      color: #60a5fa;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      border: 1px solid rgba(59, 130, 246, 0.4);
    }
    .swagger-ui .topbar { display: none !important; }
  </style>
</head>
<body>
  <div class="custom-bar">
    <h1>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
        <polyline points="2 17 12 22 22 17"></polyline>
        <polyline points="2 12 12 17 22 12"></polyline>
      </svg>
      Fleet Vision · TCP Server API Docs
    </h1>
    <span class="badge">OpenAPI 3.0 · Port 8501</span>
  </div>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js" charset="UTF-8"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-standalone-preset.js" charset="UTF-8"></script>
  <script>
    window.onload = function() {
      window.ui = SwaggerUIBundle({
        url: "/openapi.json",
        dom_id: '#swagger-ui',
        deepLinking: true,
        filter: true,
        docExpansion: "list",
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        layout: "BaseLayout"
      });
    };
  </script>
</body>
</html>`

	_, _ = w.Write([]byte(html))
}
