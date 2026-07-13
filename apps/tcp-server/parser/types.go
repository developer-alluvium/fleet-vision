package parser

import "time"

// AVLRecord represents a single parsed AVL data record from a Teltonika device.
type AVLRecord struct {
	Timestamp  time.Time         `json:"timestamp"`
	Priority   uint8             `json:"priority"`
	Longitude  float64           `json:"longitude"`
	Latitude   float64           `json:"latitude"`
	Altitude   int16             `json:"altitude"`
	Angle      uint16            `json:"angle"`
	Satellites uint8             `json:"satellites"`
	Speed      uint16            `json:"speed"`
	EventID    uint16            `json:"event_id,omitempty"`
	IOElements map[string]uint64 `json:"io_elements"`
}

// TelemetryMessage is the JSON envelope pushed to Kafka.
type TelemetryMessage struct {
	IMEI            string      `json:"imei"`
	Records         []AVLRecord `json:"records"`
	Codec           string      `json:"codec"`
	ServerTimestamp  string      `json:"server_timestamp"`
}

// AVLPacket holds the full parsed packet metadata alongside the records.
type AVLPacket struct {
	CodecID     byte
	RecordCount uint8
	Records     []AVLRecord
}
