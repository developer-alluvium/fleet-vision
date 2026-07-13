package main

import (
	"context"
	"log"
	"time"

	"github.com/segmentio/kafka-go"
)

// KafkaProducer wraps a kafka-go Writer for producing telemetry messages.
type KafkaProducer struct {
	writer *kafka.Writer
}

// NewKafkaProducer creates a new Kafka producer targeting the specified brokers and topic.
// Messages are partitioned by key (IMEI) for per-device ordering guarantees.
func NewKafkaProducer(brokers []string, topic string) *KafkaProducer {
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
