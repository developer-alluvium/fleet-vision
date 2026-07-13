package parser

import (
	"encoding/binary"
	"fmt"
	"strconv"
	"time"
)

// ──────────────────────────────────────────────────────────────
// Codec 8 / Codec 8 Extended AVL Data Parser
//
// Teltonika binary protocol reference:
//   https://wiki.teltonika-gps.com/view/Codec#Codec_8
//   https://wiki.teltonika-gps.com/view/Codec#Codec_8_Extended
//
// Packet layout (after TCP framing):
//   [4 bytes preamble 0x00000000]
//   [4 bytes data length]
//   [1 byte  codec ID]
//   [1 byte  record count]
//   [N × AVL records …]
//   [1 byte  record count (repeat)]
//   [4 bytes CRC-16]
// ──────────────────────────────────────────────────────────────

const (
	CodecID8  byte = 0x08
	CodecID8E byte = 0x8E
)

// ParseAVLPacket parses a full AVL data packet (everything after preamble + data length have been read).
// The `data` slice should start at the Codec ID byte and include everything up to (but not including) the CRC.
func ParseAVLPacket(data []byte) (*AVLPacket, error) {
	if len(data) < 3 {
		return nil, fmt.Errorf("packet too short: %d bytes", len(data))
	}

	codecID := data[0]
	recordCount := data[1]

	if codecID != CodecID8 && codecID != CodecID8E {
		return nil, fmt.Errorf("unsupported codec: 0x%02X", codecID)
	}

	offset := 2
	records := make([]AVLRecord, 0, recordCount)

	for i := 0; i < int(recordCount); i++ {
		rec, bytesRead, err := parseAVLRecord(data[offset:], codecID)
		if err != nil {
			return nil, fmt.Errorf("record %d: %w", i, err)
		}
		records = append(records, rec)
		offset += bytesRead
	}

	// Validate trailing record count
	if offset >= len(data) {
		return nil, fmt.Errorf("packet truncated: no trailing record count")
	}
	trailingCount := data[offset]
	if trailingCount != recordCount {
		return nil, fmt.Errorf("record count mismatch: header=%d trailer=%d", recordCount, trailingCount)
	}

	return &AVLPacket{
		CodecID:     codecID,
		RecordCount: recordCount,
		Records:     records,
	}, nil
}

// parseAVLRecord parses a single AVL record starting at buf[0].
// Returns the parsed record and the number of bytes consumed.
func parseAVLRecord(buf []byte, codecID byte) (AVLRecord, int, error) {
	if len(buf) < 30 { // minimum: 8 (ts) + 1 (pri) + 15 (gps) + some IO
		return AVLRecord{}, 0, fmt.Errorf("record buffer too short: %d bytes", len(buf))
	}

	offset := 0

	// ── Timestamp (8 bytes, milliseconds since epoch) ────────
	tsMs := int64(binary.BigEndian.Uint64(buf[offset : offset+8]))
	timestamp := time.UnixMilli(tsMs).UTC()
	offset += 8

	// ── Priority (1 byte) ────────────────────────────────────
	priority := buf[offset]
	offset++

	// ── GPS Element (15 bytes) ───────────────────────────────
	//   Longitude : 4 bytes (int32, × 10⁻⁷ degrees)
	//   Latitude  : 4 bytes (int32, × 10⁻⁷ degrees)
	//   Altitude  : 2 bytes (int16, meters)
	//   Angle     : 2 bytes (uint16, degrees)
	//   Satellites: 1 byte
	//   Speed     : 2 bytes (uint16, km/h)
	lonRaw := int32(binary.BigEndian.Uint32(buf[offset : offset+4]))
	offset += 4
	latRaw := int32(binary.BigEndian.Uint32(buf[offset : offset+4]))
	offset += 4
	altitude := int16(binary.BigEndian.Uint16(buf[offset : offset+2]))
	offset += 2
	angle := binary.BigEndian.Uint16(buf[offset : offset+2])
	offset += 2
	satellites := buf[offset]
	offset++
	speed := binary.BigEndian.Uint16(buf[offset : offset+2])
	offset += 2

	longitude := float64(lonRaw) / 1e7
	latitude := float64(latRaw) / 1e7

	// ── IO Elements ──────────────────────────────────────────
	ioElements := make(map[string]uint64)
	var bytesConsumed int
	var eventID uint16
	var err error

	switch codecID {
	case CodecID8:
		bytesConsumed, eventID, err = parseIOCodec8(buf[offset:], ioElements)
	case CodecID8E:
		bytesConsumed, eventID, err = parseIOCodec8E(buf[offset:], ioElements)
	}
	if err != nil {
		return AVLRecord{}, 0, fmt.Errorf("IO parse error: %w", err)
	}
	offset += bytesConsumed

	rec := AVLRecord{
		Timestamp:  timestamp,
		Priority:   priority,
		Longitude:  longitude,
		Latitude:   latitude,
		Altitude:   altitude,
		Angle:      angle,
		Satellites: satellites,
		Speed:      speed,
		EventID:    eventID,
		IOElements: ioElements,
	}

	return rec, offset, nil
}

// ──────────────────────────────────────────────────────────────
// Codec 8 IO Element Parser
//
// Layout:
//   [1 byte  Event IO ID]
//   [1 byte  Total IO count]
//   [1 byte  N1 count] [N1 × (1-byte ID + 1-byte value)]
//   [1 byte  N2 count] [N2 × (1-byte ID + 2-byte value)]
//   [1 byte  N4 count] [N4 × (1-byte ID + 4-byte value)]
//   [1 byte  N8 count] [N8 × (1-byte ID + 8-byte value)]
// ──────────────────────────────────────────────────────────────

func parseIOCodec8(buf []byte, out map[string]uint64) (int, uint16, error) {
	if len(buf) < 2 {
		return 0, 0, fmt.Errorf("IO buffer too short for Codec 8 header")
	}
	offset := 0

	// Event IO ID (1 byte) – which IO triggered this record (0 = periodic)
	eventIOID := uint16(buf[offset])
	offset++

	// Total IO element count (1 byte) – informational, we parse by groups
	_ = buf[offset] // totalCount
	offset++

	// Parse each value-width group: 1, 2, 4, 8 bytes
	valueSizes := []int{1, 2, 4, 8}
	for _, vSize := range valueSizes {
		if offset >= len(buf) {
			return 0, 0, fmt.Errorf("IO buffer truncated before N%d group", vSize)
		}
		count := int(buf[offset])
		offset++

		for j := 0; j < count; j++ {
			if offset+1+vSize > len(buf) {
				return 0, 0, fmt.Errorf("IO buffer truncated in N%d element %d", vSize, j)
			}

			ioID := buf[offset]
			offset++

			var val uint64
			switch vSize {
			case 1:
				val = uint64(buf[offset])
			case 2:
				val = uint64(binary.BigEndian.Uint16(buf[offset : offset+2]))
			case 4:
				val = uint64(binary.BigEndian.Uint32(buf[offset : offset+4]))
			case 8:
				val = binary.BigEndian.Uint64(buf[offset : offset+8])
			}
			offset += vSize

			// Use string key so JSON serializes cleanly
			out[strconv.Itoa(int(ioID))] = val
		}
	}

	return offset, eventIOID, nil
}

// ──────────────────────────────────────────────────────────────
// Codec 8 Extended IO Element Parser
//
// Layout (differs from Codec 8 by using 2-byte IO IDs and adding NX variable-length group):
//   [2 bytes Event IO ID]
//   [2 bytes Total IO count]
//   [2 bytes N1 count] [N1 × (2-byte ID + 1-byte value)]
//   [2 bytes N2 count] [N2 × (2-byte ID + 2-byte value)]
//   [2 bytes N4 count] [N4 × (2-byte ID + 4-byte value)]
//   [2 bytes N8 count] [N8 × (2-byte ID + 8-byte value)]
//   [2 bytes NX count] [NX × (2-byte ID + 2-byte length + variable value)]
// ──────────────────────────────────────────────────────────────

func parseIOCodec8E(buf []byte, out map[string]uint64) (int, uint16, error) {
	if len(buf) < 4 {
		return 0, 0, fmt.Errorf("IO buffer too short for Codec 8E header")
	}
	offset := 0

	// Event IO ID (2 bytes)
	eventIOID := binary.BigEndian.Uint16(buf[offset : offset+2])
	offset += 2

	// Total IO element count (2 bytes)
	_ = binary.BigEndian.Uint16(buf[offset : offset+2]) // totalCount
	offset += 2

	// Parse fixed-width groups: 1, 2, 4, 8 bytes
	valueSizes := []int{1, 2, 4, 8}
	for _, vSize := range valueSizes {
		if offset+2 > len(buf) {
			return 0, 0, fmt.Errorf("IO buffer truncated before N%d group count", vSize)
		}
		count := int(binary.BigEndian.Uint16(buf[offset : offset+2]))
		offset += 2

		for j := 0; j < count; j++ {
			if offset+2+vSize > len(buf) {
				return 0, 0, fmt.Errorf("IO buffer truncated in N%d element %d", vSize, j)
			}

			ioID := binary.BigEndian.Uint16(buf[offset : offset+2])
			offset += 2

			var val uint64
			switch vSize {
			case 1:
				val = uint64(buf[offset])
			case 2:
				val = uint64(binary.BigEndian.Uint16(buf[offset : offset+2]))
			case 4:
				val = uint64(binary.BigEndian.Uint32(buf[offset : offset+4]))
			case 8:
				val = binary.BigEndian.Uint64(buf[offset : offset+8])
			}
			offset += vSize

			out[strconv.Itoa(int(ioID))] = val
		}
	}

	// Parse variable-length group (NX)
	if offset+2 > len(buf) {
		return 0, 0, fmt.Errorf("IO buffer truncated before NX group count")
	}
	nxCount := int(binary.BigEndian.Uint16(buf[offset : offset+2]))
	offset += 2

	for j := 0; j < nxCount; j++ {
		if offset+4 > len(buf) {
			return 0, 0, fmt.Errorf("IO buffer truncated in NX element %d header", j)
		}

		ioID := binary.BigEndian.Uint16(buf[offset : offset+2])
		offset += 2
		vLen := int(binary.BigEndian.Uint16(buf[offset : offset+2]))
		offset += 2

		if offset+vLen > len(buf) {
			return 0, 0, fmt.Errorf("IO buffer truncated in NX element %d value (need %d bytes)", j, vLen)
		}

		// For variable-length values, store what fits in uint64 (up to 8 bytes).
		// Longer values (e.g., BLE beacons) are truncated – extend if needed.
		var val uint64
		if vLen <= 8 {
			for k := 0; k < vLen; k++ {
				val = (val << 8) | uint64(buf[offset+k])
			}
		}
		offset += vLen

		out[strconv.Itoa(int(ioID))] = val
	}

	return offset, eventIOID, nil
}

// CRC16IBM calculates the CRC-16/ARC (IBM) checksum used by Teltonika.
// Polynomial: 0xA001 (bit-reversed 0x8005).
func CRC16IBM(data []byte) uint16 {
	var crc uint16 = 0x0000
	for _, b := range data {
		crc ^= uint16(b)
		for i := 0; i < 8; i++ {
			if crc&1 != 0 {
				crc = (crc >> 1) ^ 0xA001
			} else {
				crc >>= 1
			}
		}
	}
	return crc
}
