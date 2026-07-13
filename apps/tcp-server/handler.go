package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"time"

	"fleet-vision/tcp-server/parser"
)

const (
	// Connection timeouts
	handshakeTimeout = 10 * time.Second
	readTimeout      = 90 * time.Second // Teltonika devices typically send every 30-60s
	writeTimeout     = 5 * time.Second

	// Protocol constants
	imeiAccepted byte = 0x01
	imeiRejected byte = 0x00
)

// handleConnection manages the full lifecycle of a single device TCP connection:
//  1. IMEI handshake
//  2. AVL data receive loop (parse → produce to Kafka → ACK)
//  3. Clean disconnect
func handleConnection(conn net.Conn, producer *KafkaProducer) {
	defer conn.Close()
	remoteAddr := conn.RemoteAddr().String()
	log.Printf("[CONN] New connection from %s", remoteAddr)

	// ── Step 1: IMEI Handshake ───────────────────────────────
	imei, err := performIMEIHandshake(conn)
	if err != nil {
		log.Printf("[CONN] %s handshake failed: %v", remoteAddr, err)
		return
	}
	log.Printf("[CONN] %s identified as IMEI %s", remoteAddr, imei)

	// ── Step 2: AVL Data Loop ────────────────────────────────
	for {
		conn.SetReadDeadline(time.Now().Add(readTimeout))

		packet, err := readAVLPacket(conn)
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				log.Printf("[CONN] %s (IMEI %s) timed out – disconnecting", remoteAddr, imei)
			} else if err == io.EOF {
				log.Printf("[CONN] %s (IMEI %s) disconnected", remoteAddr, imei)
			} else {
				log.Printf("[CONN] %s (IMEI %s) read error: %v", remoteAddr, imei, err)
			}
			return
		}

		// Parse the AVL packet
		avlPacket, err := parser.ParseAVLPacket(packet.data)
		if err != nil {
			log.Printf("[PARSE] %s (IMEI %s) parse error: %v", remoteAddr, imei, err)
			// Send 0 ACK to signal error – device will resend
			sendACK(conn, 0)
			continue
		}

		log.Printf("[PARSE] %s (IMEI %s) parsed %d records (codec=0x%02X)",
			remoteAddr, imei, avlPacket.RecordCount, avlPacket.CodecID)

		// Build the telemetry message
		codecName := "codec8"
		if avlPacket.CodecID == parser.CodecID8E {
			codecName = "codec8e"
		}
		msg := parser.TelemetryMessage{
			IMEI:           imei,
			Records:        avlPacket.Records,
			Codec:          codecName,
			ServerTimestamp: time.Now().UTC().Format(time.RFC3339Nano),
		}

		jsonBytes, err := json.Marshal(msg)
		if err != nil {
			log.Printf("[CONN] %s (IMEI %s) JSON marshal error: %v", remoteAddr, imei, err)
			sendACK(conn, 0)
			continue
		}

		// ── Step 3: Produce to Kafka (synchronous) ───────────
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		err = producer.Publish(ctx, imei, jsonBytes)
		cancel()

		if err != nil {
			log.Printf("[CONN] %s (IMEI %s) Kafka publish failed – NOT acknowledging device: %v",
				remoteAddr, imei, err)
			// Do NOT ACK the device – it will retry sending the same data
			sendACK(conn, 0)
			continue
		}

		// ── Step 4: ACK the device ───────────────────────────
		// Only after Kafka confirms the write
		sendACK(conn, int(avlPacket.RecordCount))
		log.Printf("[CONN] %s (IMEI %s) ACK sent for %d records",
			remoteAddr, imei, avlPacket.RecordCount)
	}
}

// ──────────────────────────────────────────────────────────────
// IMEI Handshake
//
// Protocol:
//   Device sends: [2 bytes: IMEI length] [N bytes: IMEI as ASCII]
//   Server replies: [1 byte: 0x01 = accepted, 0x00 = rejected]
// ──────────────────────────────────────────────────────────────

func performIMEIHandshake(conn net.Conn) (string, error) {
	conn.SetReadDeadline(time.Now().Add(handshakeTimeout))

	// Read 2-byte length prefix
	lenBuf := make([]byte, 2)
	if _, err := io.ReadFull(conn, lenBuf); err != nil {
		return "", fmt.Errorf("reading IMEI length: %w", err)
	}

	imeiLen := binary.BigEndian.Uint16(lenBuf)
	if imeiLen == 0 || imeiLen > 20 {
		conn.Write([]byte{imeiRejected})
		return "", fmt.Errorf("invalid IMEI length: %d", imeiLen)
	}

	// Read the IMEI string
	imeiBuf := make([]byte, imeiLen)
	if _, err := io.ReadFull(conn, imeiBuf); err != nil {
		return "", fmt.Errorf("reading IMEI: %w", err)
	}

	imei := string(imeiBuf)

	// Validate: IMEI should be 15 digits
	if !isValidIMEI(imei) {
		conn.Write([]byte{imeiRejected})
		return "", fmt.Errorf("invalid IMEI format: %q", imei)
	}

	// Accept the device
	conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	if _, err := conn.Write([]byte{imeiAccepted}); err != nil {
		return "", fmt.Errorf("writing IMEI ACK: %w", err)
	}

	return imei, nil
}

// isValidIMEI checks that the string contains only digits and is 15 characters long.
func isValidIMEI(imei string) bool {
	if len(imei) != 15 {
		return false
	}
	for _, c := range imei {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// ──────────────────────────────────────────────────────────────
// AVL Packet Reading
//
// TCP framing:
//   [4 bytes: preamble (0x00000000)]
//   [4 bytes: data field length]
//   [data field ...]
//   [4 bytes: CRC-16]
// ──────────────────────────────────────────────────────────────

type rawPacket struct {
	data []byte // everything between preamble/length header and CRC
	crc  uint16
}

func readAVLPacket(conn net.Conn) (*rawPacket, error) {
	// Read the 8-byte header: preamble + data length
	header := make([]byte, 8)
	if _, err := io.ReadFull(conn, header); err != nil {
		return nil, err
	}

	preamble := binary.BigEndian.Uint32(header[0:4])
	if preamble != 0x00000000 {
		return nil, fmt.Errorf("invalid preamble: 0x%08X", preamble)
	}

	dataLen := binary.BigEndian.Uint32(header[4:8])
	if dataLen == 0 || dataLen > 4096 { // sanity check
		return nil, fmt.Errorf("suspicious data length: %d", dataLen)
	}

	// Read the data field + 4 bytes CRC
	payload := make([]byte, dataLen+4)
	if _, err := io.ReadFull(conn, payload); err != nil {
		return nil, fmt.Errorf("reading payload: %w", err)
	}

	data := payload[:dataLen]
	crc := binary.BigEndian.Uint32(payload[dataLen:])

	// Validate CRC
	computedCRC := uint32(parser.CRC16IBM(data))
	if computedCRC != crc {
		return nil, fmt.Errorf("CRC mismatch: computed=0x%04X received=0x%08X", computedCRC, crc)
	}

	return &rawPacket{data: data, crc: uint16(crc)}, nil
}

// sendACK writes the 4-byte acknowledgement (number of records accepted) to the device.
func sendACK(conn net.Conn, recordCount int) {
	conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	ack := make([]byte, 4)
	binary.BigEndian.PutUint32(ack, uint32(recordCount))
	conn.Write(ack)
}
