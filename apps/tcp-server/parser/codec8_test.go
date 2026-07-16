package parser

import (
	"encoding/hex"
	"math"
	"testing"
	"time"
)

// ──────────────────────────────────────────────────────────────
// Test vectors sourced from the official Teltonika Codec wiki:
//   https://wiki.teltonika-gps.com/view/Codec
//
// Additional hand-crafted payloads for Codec 8E with non-zero
// GPS coordinates matching real FMC130 device data.
// ──────────────────────────────────────────────────────────────

// TestCodec8_OfficialExample1 uses the first official Teltonika Codec 8 example:
// 1 record, zero GPS (no fix), 5 IO elements (2×1B + 1×2B + 1×4B + 1×8B).
//
// Full packet hex (including preamble + data length + CRC):
//   000000000000003608010000016B40D8EA30010000000000000000000000000000000105021503010101425E0F01F10000601A014E0000000000000000010000C7CF
//
// The data slice fed to ParseAVLPacket starts at Codec ID (0x08) and ends before the CRC.
func TestCodec8_OfficialExample1(t *testing.T) {
	// Data field: from Codec ID (08) to trailing record count (01), inclusive.
	dataHex := "08010000016B40D8EA30010000000000000000000000000000000105021503010101425E0F01F10000601A014E000000000000000001"
	data, err := hex.DecodeString(dataHex)
	if err != nil {
		t.Fatalf("hex decode failed: %v", err)
	}

	pkt, err := ParseAVLPacket(data)
	if err != nil {
		t.Fatalf("ParseAVLPacket failed: %v", err)
	}

	if pkt.CodecID != CodecID8 {
		t.Errorf("expected codec 0x08, got 0x%02X", pkt.CodecID)
	}
	if pkt.RecordCount != 1 {
		t.Errorf("expected 1 record, got %d", pkt.RecordCount)
	}

	rec := pkt.Records[0]

	// Timestamp: 0x0000016B40D8EA30 = 1560157486000 ms → 2019-06-10T10:04:46Z
	expectedTime := time.Date(2019, 6, 10, 10, 4, 46, 0, time.UTC)
	if !rec.Timestamp.Equal(expectedTime) {
		t.Errorf("timestamp: expected %v, got %v", expectedTime, rec.Timestamp)
	}

	// Priority: 1 (High)
	if rec.Priority != 1 {
		t.Errorf("priority: expected 1, got %d", rec.Priority)
	}

	// GPS: all zeros (no fix)
	if rec.Longitude != 0 {
		t.Errorf("longitude: expected 0, got %f", rec.Longitude)
	}
	if rec.Latitude != 0 {
		t.Errorf("latitude: expected 0, got %f", rec.Latitude)
	}
	if rec.Altitude != 0 {
		t.Errorf("altitude: expected 0, got %d", rec.Altitude)
	}
	if rec.Angle != 0 {
		t.Errorf("angle: expected 0, got %d", rec.Angle)
	}
	if rec.Satellites != 0 {
		t.Errorf("satellites: expected 0, got %d", rec.Satellites)
	}
	if rec.Speed != 0 {
		t.Errorf("speed: expected 0, got %d", rec.Speed)
	}

	// IO Elements
	// Event IO ID = 0x01
	if rec.EventID != 1 {
		t.Errorf("eventID: expected 1, got %d", rec.EventID)
	}
	// Total 5 IOs: N1=2 (ID 21=3, ID 1=1), N2=1 (ID 66=0x5E0F=24079), N4=1 (ID 241=0x0000601A=24602), N8=1 (ID 78=0)
	assertIO(t, rec.IOElements, "21", 3)
	assertIO(t, rec.IOElements, "1", 1)
	assertIO(t, rec.IOElements, "66", 0x5E0F) // External Voltage = 24079 mV
	assertIO(t, rec.IOElements, "241", 0x0000601A) // Active GSM Operator = 24602
	assertIO(t, rec.IOElements, "78", 0) // iButton = 0
}

// TestCodec8_OfficialExample3 uses the third official Teltonika Codec 8 example:
// 2 records, each with 1 IO element (1×1B).
//
// Full hex:
//   000000000000004308020000016B40D57B480100000000000000000000000000000001010101000000000000016B40D5C19801000000000000000000000000000000010101010100000002000252C
func TestCodec8_TwoRecords(t *testing.T) {
	dataHex := "08020000016B40D57B4801000000000000000000000000000000010101010000000000" +
		"0000016B40D5C198010000000000000000000000000000000101010101000000020000252C"
	// Wait — this doesn't include the trailing record count in the data hex as expected.
	// Let me reconstruct from the full packet:
	// Full: 000000000000004308020000016B40D57B480100000000000000000000000000000001010101000000000000016B40D5C1980100000000000000000000000000000001010101010000000200 0252C
	// Data field (between preamble+length and CRC):
	// 08020000016B40D57B480100000000000000000000000000000001010101000000000000016B40D5C198010000000000000000000000000000000101010101000000020000
	// CRC = 252C

	dataHex = "08020000016B40D57B480100000000000000000000000000000001010101000000000000016B40D5C19801000000000000000000000000000000010101010100000002"
	data, err := hex.DecodeString(dataHex)
	if err != nil {
		t.Fatalf("hex decode failed: %v", err)
	}

	pkt, err := ParseAVLPacket(data)
	if err != nil {
		t.Fatalf("ParseAVLPacket failed: %v", err)
	}

	if pkt.RecordCount != 2 {
		t.Errorf("expected 2 records, got %d", pkt.RecordCount)
	}
	if len(pkt.Records) != 2 {
		t.Fatalf("expected 2 parsed records, got %d", len(pkt.Records))
	}

	// Record 1: timestamp 0x0000016B40D57B48 = 2019-06-10 10:01:01 UTC
	rec1 := pkt.Records[0]
	expected1 := time.Date(2019, 6, 10, 10, 1, 1, 0, time.UTC)
	if !rec1.Timestamp.Equal(expected1) {
		t.Errorf("record 1 timestamp: expected %v, got %v", expected1, rec1.Timestamp)
	}
	assertIO(t, rec1.IOElements, "1", 0) // DIN1 = 0

	// Record 2: timestamp 0x0000016B40D5C198 (should be after record 1)
	rec2 := pkt.Records[1]
	// Verify it's after rec1
	if !rec2.Timestamp.After(rec1.Timestamp) {
		t.Errorf("record 2 timestamp %v should be after record 1 %v", rec2.Timestamp, rec1.Timestamp)
	}
	assertIO(t, rec2.IOElements, "1", 1) // DIN1 = 1
}

// TestCodec8E_WithGPSCoordinates tests Codec 8 Extended parsing with a hand-crafted
// packet containing non-zero GPS coordinates similar to what the FMC130 device sends.
//
// This validates:
// - Correct Longitude/Latitude parsing with signed int32 → float64 conversion
// - Codec 8E 2-byte IO IDs and counts
// - GPS field order: Lon(4) → Lat(4) → Alt(2) → Angle(2) → Sat(1) → Speed(2)
func TestCodec8E_WithGPSCoordinates(t *testing.T) {
	// Construct a Codec 8E packet by hand:
	//
	// Codec ID: 0x8E
	// Number of Data 1: 0x01
	//
	// AVL Record:
	//   Timestamp: 0x00000191E7D93A00 (arbitrary, ~2026-07-10T12:29:02Z)
	//              Let's use 1783878542000 ms = 2026-07-10T12:29:02.000Z
	//              Hex: 0x0000019F3A5BD0 ... let me compute:
	//              Actually let's just use a simple known value.
	//              Use: 0x0000016B40D8EA30 (same as example 1 = 2019-06-10T10:04:46Z)
	//
	//   Priority: 0x00 (Low)
	//
	//   GPS:
	//     Longitude: 72.5705933° → raw = 725705933 = 0x2B3F3CCD
	//     Latitude:  23.0209666° → raw = 230209666 = 0x0DB96482
	//     Altitude:  115m → 0x0073
	//     Angle:     359° → 0x0167
	//     Satellites: 17 → 0x11
	//     Speed:     0 km/h → 0x0000
	//
	//   IO Elements (Codec 8E uses 2-byte IDs/counts):
	//     Event IO ID: 0x00EF (239, Ignition)
	//     Total IO count: 0x0002
	//     N1 count: 0x0002
	//       IO ID 0x00EF (239) = 0x00 (Ignition Off)
	//       IO ID 0x00F0 (240) = 0x01 (Movement Yes)
	//     N2 count: 0x0000
	//     N4 count: 0x0000
	//     N8 count: 0x0000
	//     NX count: 0x0000
	//
	// Number of Data 2: 0x01

	dataHex := "" +
		"8E" + // Codec ID
		"01" + // Number of Data 1
		// --- AVL Record ---
		"0000016B40D8EA30" + // Timestamp (same as official example)
		"00" + // Priority (Low)
		// GPS element (15 bytes):
		"2B4164CD" + // Longitude raw: 725705933 → 72.5705933°
		"0DB8B882" + // Latitude raw:  230209666 → 23.0209666°
		"0073" + // Altitude: 115m
		"0167" + // Angle: 359°
		"11" + // Satellites: 17
		"0000" + // Speed: 0 km/h
		// IO Elements (Codec 8E format):
		"00EF" + // Event IO ID: 239 (Ignition)
		"0002" + // Total IO count: 2
		"0002" + // N1 count: 2
		"00EF" + "00" + // IO 239 (Ignition) = 0
		"00F0" + "01" + // IO 240 (Movement) = 1
		"0000" + // N2 count: 0
		"0000" + // N4 count: 0
		"0000" + // N8 count: 0
		"0000" + // NX count: 0
		// --- End AVL Record ---
		"01" // Number of Data 2

	data, err := hex.DecodeString(dataHex)
	if err != nil {
		t.Fatalf("hex decode failed: %v", err)
	}

	pkt, err := ParseAVLPacket(data)
	if err != nil {
		t.Fatalf("ParseAVLPacket failed: %v", err)
	}

	if pkt.CodecID != CodecID8E {
		t.Errorf("expected codec 0x8E, got 0x%02X", pkt.CodecID)
	}
	if pkt.RecordCount != 1 {
		t.Errorf("expected 1 record, got %d", pkt.RecordCount)
	}

	rec := pkt.Records[0]

	// GPS coordinate validation with tolerance for float precision
	const tolerance = 1e-7
	expectedLon := 72.5705933
	expectedLat := 23.0209666
	if math.Abs(rec.Longitude-expectedLon) > tolerance {
		t.Errorf("longitude: expected %f, got %f (diff=%e)", expectedLon, rec.Longitude, rec.Longitude-expectedLon)
	}
	if math.Abs(rec.Latitude-expectedLat) > tolerance {
		t.Errorf("latitude: expected %f, got %f (diff=%e)", expectedLat, rec.Latitude, rec.Latitude-expectedLat)
	}

	if rec.Altitude != 115 {
		t.Errorf("altitude: expected 115, got %d", rec.Altitude)
	}
	if rec.Angle != 359 {
		t.Errorf("angle: expected 359, got %d", rec.Angle)
	}
	if rec.Satellites != 17 {
		t.Errorf("satellites: expected 17, got %d", rec.Satellites)
	}
	if rec.Speed != 0 {
		t.Errorf("speed: expected 0, got %d", rec.Speed)
	}

	// IO elements
	if rec.EventID != 239 {
		t.Errorf("eventID: expected 239, got %d", rec.EventID)
	}
	assertIO(t, rec.IOElements, "239", 0) // Ignition Off
	assertIO(t, rec.IOElements, "240", 1) // Movement Yes
}

// TestCodec8E_NegativeCoordinates validates that negative coordinates
// (south latitude / west longitude) are correctly decoded via two's complement.
func TestCodec8E_NegativeCoordinates(t *testing.T) {
	// GPS coordinates:
	//   Latitude: -33.8688197° (Sydney, Australia) → raw = -338688197 = int32
	//     -338688197 in hex (two's complement): 0xEBBE813B
	//   Longitude: 151.2092955° → raw = 1512092955 = 0x5A21DD1B
	//   Altitude: 58m → 0x003A
	//   Angle: 180° → 0x00B4
	//   Satellites: 12 → 0x0C
	//   Speed: 45 km/h → 0x002D

	dataHex := "" +
		"8E" + // Codec ID
		"01" + // Number of Data 1
		"0000016B40D8EA30" + // Timestamp
		"00" + // Priority (Low)
		// GPS:
		"5A20B51B" + // Longitude: 151.2092955
		"EBD0073B" + // Latitude: -33.8688197 (negative, two's complement)
		"003A" + // Altitude: 58m
		"00B4" + // Angle: 180°
		"0C" + // Satellites: 12
		"002D" + // Speed: 45 km/h
		// IO (minimal, empty):
		"0000" + // Event IO ID: 0
		"0000" + // Total IO count: 0
		"0000" + // N1: 0
		"0000" + // N2: 0
		"0000" + // N4: 0
		"0000" + // N8: 0
		"0000" + // NX: 0
		"01" // Number of Data 2

	data, err := hex.DecodeString(dataHex)
	if err != nil {
		t.Fatalf("hex decode failed: %v", err)
	}

	pkt, err := ParseAVLPacket(data)
	if err != nil {
		t.Fatalf("ParseAVLPacket failed: %v", err)
	}

	rec := pkt.Records[0]

	const tolerance = 1e-7

	expectedLon := 151.2092955
	if math.Abs(rec.Longitude-expectedLon) > tolerance {
		t.Errorf("longitude: expected %f, got %f", expectedLon, rec.Longitude)
	}

	expectedLat := -33.8688197
	if math.Abs(rec.Latitude-expectedLat) > tolerance {
		t.Errorf("latitude: expected %f, got %f", expectedLat, rec.Latitude)
	}

	if rec.Altitude != 58 {
		t.Errorf("altitude: expected 58, got %d", rec.Altitude)
	}
	if rec.Angle != 180 {
		t.Errorf("angle: expected 180, got %d", rec.Angle)
	}
	if rec.Satellites != 12 {
		t.Errorf("satellites: expected 12, got %d", rec.Satellites)
	}
	if rec.Speed != 45 {
		t.Errorf("speed: expected 45, got %d", rec.Speed)
	}
}

// TestCodec8_ZeroGPS_AllFieldsZero verifies that when the device has no GPS fix,
// all GPS fields are correctly reported as zero rather than garbage values.
func TestCodec8_ZeroGPS(t *testing.T) {
	// Use official example 1 which has all-zero GPS
	dataHex := "08010000016B40D8EA30010000000000000000000000000000000105021503010101425E0F01F10000601A014E000000000000000001"
	data, _ := hex.DecodeString(dataHex)

	pkt, err := ParseAVLPacket(data)
	if err != nil {
		t.Fatalf("ParseAVLPacket failed: %v", err)
	}

	rec := pkt.Records[0]
	if rec.Longitude != 0 || rec.Latitude != 0 {
		t.Errorf("expected 0,0 for no-fix GPS, got lon=%f lat=%f", rec.Longitude, rec.Latitude)
	}
	if rec.Altitude != 0 || rec.Angle != 0 || rec.Satellites != 0 || rec.Speed != 0 {
		t.Errorf("expected all GPS fields to be 0 for no-fix, got alt=%d angle=%d sat=%d speed=%d",
			rec.Altitude, rec.Angle, rec.Satellites, rec.Speed)
	}
}

// TestCRC16IBM validates the CRC-16/IBM implementation against known values.
func TestCRC16IBM(t *testing.T) {
	// From official example 1: CRC of data field = 0xC7CF
	dataHex := "08010000016B40D8EA30010000000000000000000000000000000105021503010101425E0F01F10000601A014E000000000000000001"
	data, _ := hex.DecodeString(dataHex)

	crc := CRC16IBM(data)
	if crc != 0xC7CF {
		t.Errorf("CRC16IBM: expected 0xC7CF, got 0x%04X", crc)
	}

	// From official example 2: CRC = 0xF22A
	dataHex2 := "08010000016B40D9AD80010000000000000000000000000000000103021503010101425E100000010000"
	data2, _ := hex.DecodeString(dataHex2)

	crc2 := CRC16IBM(data2)
	// Note: need to verify trailing record count byte is included
	// The CRC is computed from Codec ID to Number of Data 2 (inclusive)
	// The hex above already ends with "01" for Number of Data 2
	// Wait, let me re-check the hex. The full packet is:
	// 000000000000002808010000016B40D9AD80010000000000000000000000000000000103021503010101425E100000010000F22A
	// Data field length = 0x28 = 40 bytes
	// So data = 08010000016B40D9AD80010000000000000000000000000000000103021503010101425E1000000100
	// Wait, that's only 39 bytes. Let me recount.
	// After preamble (4) + length (4) = 8 bytes header
	// Full hex = 000000000000002808010000016B40D9AD80010000000000000000000000000000000103021503010101425E100000010000F22A
	// Remove first 16 hex chars (8 bytes preamble+length): 08010000016B40D9AD80010000000000000000000000000000000103021503010101425E100000010000F22A
	// Remove last 8 hex chars (4 bytes CRC): 08010000016B40D9AD800100000000000000000000000000000001030215030101014 25E10000001
	// Wait, let me just verify example 2 CRC matches:
	dataHex2correct := "08010000016B40D9AD80010000000000000000000000000000000103021503010101425E10000001"
	data2c, _ := hex.DecodeString(dataHex2correct)
	crc2c := CRC16IBM(data2c)
	if crc2c != 0xF22A {
		t.Errorf("CRC16IBM example 2: expected 0xF22A, got 0x%04X", crc2c)
	}
	_ = crc2 // suppress unused
}

// assertIO is a helper to check a specific IO element value.
func assertIO(t *testing.T, ioElements map[string]uint64, key string, expected uint64) {
	t.Helper()
	val, ok := ioElements[key]
	if !ok {
		t.Errorf("IO element %q not found (have: %v)", key, ioElements)
		return
	}
	if val != expected {
		t.Errorf("IO element %q: expected %d, got %d", key, expected, val)
	}
}
