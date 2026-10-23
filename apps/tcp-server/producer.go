package main

import (
	"context"
	"crypto/tls"
	"log"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/session"
	sigv4 "github.com/aws/aws-sdk-go/aws/signer/v4"
	"github.com/segmentio/kafka-go"
	"github.com/segmentio/kafka-go/sasl"
	"github.com/segmentio/kafka-go/sasl/aws_msk_iam"
	"github.com/segmentio/kafka-go/sasl/plain"
	"github.com/segmentio/kafka-go/sasl/scram"
)

// KafkaProducer wraps a kafka-go Writer for producing telemetry messages.
type KafkaProducer struct {
	writer *kafka.Writer
}

// extractAwsRegion extracts the AWS region from environment variables or broker hostnames.
func extractAwsRegion(brokers []string) string {
	if r := os.Getenv("AWS_REGION"); r != "" {
		return r
	}
	if r := os.Getenv("AWS_DEFAULT_REGION"); r != "" {
		return r
	}
	re := regexp.MustCompile(`\.([a-z]{2}-[a-z]+-\d+)\.amazonaws\.com`)
	for _, b := range brokers {
		matches := re.FindStringSubmatch(b)
		if len(matches) > 1 {
			return matches[1]
		}
	}
	return "ap-south-1"
}

// buildKafkaTransport inspects environment variables and broker addresses to determine
// if TLS or SASL authentication is required, and configures a kafka.Transport accordingly.
func buildKafkaTransport(brokers []string) *kafka.Transport {
	tlsEnv := strings.ToLower(os.Getenv("KAFKA_USE_TLS"))
	sslEnv := strings.ToLower(os.Getenv("KAFKA_SSL"))
	useTLS := tlsEnv == "true" || tlsEnv == "1" || tlsEnv == "yes" || sslEnv == "true" || sslEnv == "1" || sslEnv == "yes"

	// Auto-detect if AWS MSK IAM authentication is needed (port 9098 or kafka-serverless)
	isMskIam := strings.ToUpper(os.Getenv("KAFKA_SASL_MECHANISM")) == "AWS_MSK_IAM" ||
		strings.ToUpper(os.Getenv("KAFKA_SASL_MECHANISM")) == "OAUTHBEARER"

	if !isMskIam {
		for _, b := range brokers {
			bTrim := strings.TrimSpace(b)
			if strings.HasSuffix(bTrim, ":9098") || strings.Contains(bTrim, "kafka-serverless") {
				isMskIam = true
				break
			}
		}
	}

	// Auto-detect TLS if broker port indicates TLS (e.g. :9094 for AWS MSK TLS, :9098 for MSK IAM TLS, :443)
	if isMskIam {
		useTLS = true
	} else if !useTLS {
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
	if !useTLS && !isMskIam && saslUser == "" {
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

	if isMskIam {
		region := extractAwsRegion(brokers)
		sess, err := session.NewSessionWithOptions(session.Options{
			Config: aws.Config{
				Region: aws.String(region),
			},
			SharedConfigState: session.SharedConfigEnable,
		})
		if err != nil {
			log.Printf("[KAFKA] ✗ Failed to create AWS session for MSK IAM: %v", err)
		} else {
			signer := sigv4.NewSigner(sess.Config.Credentials)
			transport.SASL = &aws_msk_iam.Mechanism{
				Signer: signer,
				Region: region,
			}
			log.Printf("[KAFKA] AWS MSK IAM authentication enabled (region=%s)", region)
		}
	} else if saslUser != "" && saslPass != "" {
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
