package main

import (
	"bufio"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
)

func main() {
	// Load environment variables from .env file
	loadEnv()

	// ── Configuration from environment ───────────────────────
	tcpPort := getEnv("TCP_PORT", "8500")
	kafkaBrokers := getEnv("KAFKA_BROKERS", "localhost:9092")
	kafkaTopic := getEnv("KAFKA_TOPIC", "telemetry-raw")

	brokerList := strings.Split(kafkaBrokers, ",")

	log.Println("┌──────────────────────────────────────────────┐")
	log.Println("│        Fleet Vision · TCP Gateway            │")
	log.Println("├──────────────────────────────────────────────┤")
	log.Printf("│  TCP Port    : %s\n", tcpPort)
	log.Printf("│  Kafka       : %s\n", kafkaBrokers)
	log.Printf("│  Topic       : %s\n", kafkaTopic)
	log.Println("└──────────────────────────────────────────────┘")

	// ── Initialize Kafka Producer ────────────────────────────
	producer := NewKafkaProducer(brokerList, kafkaTopic)
	defer producer.Close()

	// ── Start TCP Listener ───────────────────────────────────
	listener, err := net.Listen("tcp", fmt.Sprintf(":%s", tcpPort))
	if err != nil {
		log.Fatalf("[FATAL] Cannot listen on port %s: %v", tcpPort, err)
	}
	defer listener.Close()
	log.Printf("[TCP] Listening on :%s for Teltonika devices…", tcpPort)

	// ── Graceful Shutdown ────────────────────────────────────
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		sig := <-sigChan
		log.Printf("[SHUTDOWN] Received %v – shutting down…", sig)
		listener.Close()
		producer.Close()
		os.Exit(0)
	}()

	// ── Accept Loop ──────────────────────────────────────────
	for {
		conn, err := listener.Accept()
		if err != nil {
			// Check if we're shutting down
			select {
			default:
				log.Printf("[TCP] Accept error: %v", err)
				continue
			}
		}
		go handleConnection(conn, producer)
	}
}

// loadEnv searches for a .env file up to 4 levels up and loads its key-value pairs into the environment.
func loadEnv() {
	dir := "."
	for i := 0; i < 4; i++ {
		path := filepath.Join(dir, ".env")
		if _, err := os.Stat(path); err == nil {
			file, err := os.Open(path)
			if err != nil {
				break
			}
			defer file.Close()
			scanner := bufio.NewScanner(file)
			for scanner.Scan() {
				line := strings.TrimSpace(scanner.Text())
				if line == "" || strings.HasPrefix(line, "#") {
					continue
				}
				parts := strings.SplitN(line, "=", 2)
				if len(parts) == 2 {
					key := strings.TrimSpace(parts[0])
					val := strings.TrimSpace(parts[1])
					// Unquote if quoted
					if (strings.HasPrefix(val, "\"") && strings.HasSuffix(val, "\"")) ||
						(strings.HasPrefix(val, "'") && strings.HasSuffix(val, "'")) {
						val = val[1 : len(val)-1]
					}
					if os.Getenv(key) == "" {
						os.Setenv(key, val)
					}
				}
			}
			break
		}
		dir = filepath.Join(dir, "..")
	}
}

// getEnv reads an environment variable with a fallback default.
func getEnv(key, fallback string) string {
	if val, ok := os.LookupEnv(key); ok && val != "" {
		return val
	}
	return fallback
}
