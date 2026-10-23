package main

import (
	"context"
	"crypto/tls"
	"log"
	"os"
	"strings"
	"time"

	"github.com/segmentio/kafka-go"
	"github.com/segmentio/kafka-go/sasl"
	"github.com/segmentio/kafka-go/sasl/plain"
	"github.com/segmentio/kafka-go/sasl/scram"
)

// KafkaProducer wraps a kafka-go Writer for producing telemetry messages.
type KafkaProducer struct {
	writer *kafka.Writer
}

// buildKafkaTransport inspects environment variables and broker addresses to determine
// if TLS or SASL authentication is required, and configures a kafka.Transport accordingly.
func buildKafkaTransport(brokers []string) *kafka.Transport {
	tlsEnv := strings.ToLower(os.Getenv("KAFKA_USE_TLS"))
	sslEnv := strings.ToLower(os.Getenv("KAFKA_SSL"))
	useTLS := tlsEnv == "true" || tlsEnv == "1" || tlsEnv == "yes" || sslEnv == "true" || sslEnv == "1" || sslEnv == "yes"

	// Auto-detect TLS if broker port indicates TLS (e.g. :9094 for AWS MSK TLS, :9098 for MSK IAM TLS, :443)
	if !useTLS {
		for _, b := range brokers {
			bTrim := strings.TrimSpace(b)
			if strings.HasSuffix(bTrim, ":9094") || strings.HasSuffix(bTrim, ":9098") || strings.HasSuffix(bTrim, ":443") {
				useTLS = true
				break
			}
		}
	}

	saslUser := os.Getenv("KAFKA_SASL_USER")
	saslPass := os.Getenv("KAFKA_SASL_PASS")

	// If neither TLS nor SASL is required, return nil to use default plaintext transport
	if !useTLS && saslUser == "" {
		return nil
	}

	transport := &kafka.Transport{
		IdleTimeout: 30 * time.Second,
	}

	if useTLS {
		tlsConfig := &tls.Config{
			MinVersion: tls.VersionTLS12,
		}
		if strings.ToLower(os.Getenv("KAFKA_TLS_INSECURE_SKIP_VERIFY")) == "true" {
			tlsConfig.InsecureSkipVerify = true
		}
		transport.TLS = tlsConfig
		log.Println("[KAFKA] TLS enabled for Kafka broker connection")
	}

	if saslUser != "" && saslPass != "" {
		saslMech := strings.ToUpper(os.Getenv("KAFKA_SASL_MECHANISM"))
		var mechanism sasl.Mechanism
		var err error

		switch saslMech {
		case "SCRAM-SHA-512":
			mechanism, err = scram.Mechanism(scram.SHA512, saslUser, saslPass)
		case "SCRAM-SHA-256":
			mechanism, err = scram.Mechanism(scram.SHA256, saslUser, saslPass)
		case "PLAIN", "":
			mechanism = plain.Mechanism{
				Username: saslUser,
				Password: saslPass,
			}
		default:
			log.Printf("[KAFKA] Unknown SASL mechanism %q, falling back to PLAIN", saslMech)
			mechanism = plain.Mechanism{
				Username: saslUser,
				Password: saslPass,
			}
		}

		if err != nil {
			log.Printf("[KAFKA] ✗ Error initializing SASL mechanism %s: %v", saslMech, err)
		} else {
			transport.SASL = mechanism
			log.Printf("[KAFKA] SASL authentication enabled (mechanism=%s, user=%s)", saslMech, saslUser)
		}
	}

	return transport
}

// NewKafkaProducer creates a new Kafka producer targeting the specified brokers and topic.
// Messages are partitioned by key (IMEI) for per-device ordering guarantees.
func NewKafkaProducer(brokers []string, topic string) *KafkaProducer {
	transport := buildKafkaTransport(brokers)

	w := &kafka.Writer{
		Addr:         kafka.TCP(brokers...),
		Topic:        topic,
		Balancer:     &kafka.Hash{}, // partition by key (IMEI)
		BatchSize:    100,
		BatchTimeout: 10 * time.Millisecond,
		WriteTimeout: 10 * time.Second,
		ReadTimeout:  10 * time.Second,
		RequiredAcks: kafka.RequireAll, // wait for all ISR replicas
		Async:        false,           // synchronous – we ACK device only after Kafka confirms
	}

	if transport != nil {
		w.Transport = transport
	}

	return &KafkaProducer{writer: w}
}

// Publish sends a single message to Kafka synchronously.
// The key is set to the IMEI so all records for a device go to the same partition.
// Returns an error if Kafka rejects the write — the caller must NOT ACK the device in that case.
func (p *KafkaProducer) Publish(ctx context.Context, key string, value []byte) error {
	msg := kafka.Message{
		Key:   []byte(key),
		Value: value,
	}
	err := p.writer.WriteMessages(ctx, msg)
	if err != nil {
		log.Printf("[KAFKA] ✗ Failed to publish (key=%s): %v", key, err)
		return err
	}
	log.Printf("[KAFKA] ✓ Published %d bytes (key=%s)", len(value), key)
	return nil
}

// Close flushes pending writes and closes the Kafka writer.
func (p *KafkaProducer) Close() error {
	log.Println("[KAFKA] Closing producer…")
	return p.writer.Close()
}
