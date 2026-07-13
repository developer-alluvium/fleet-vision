import { Kafka, Consumer, EachMessagePayload, logLevel } from "kafkajs";

// ─── Configuration ───────────────────────────────────────────

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || "localhost:9092").split(",");
const KAFKA_TOPIC = process.env.KAFKA_TOPIC || "telemetry-raw";
const CONSUMER_GROUP = process.env.CONSUMER_GROUP || "data-processor-group";

// ─── Kafka Client ────────────────────────────────────────────

const kafka = new Kafka({
  clientId: "fleet-vision-data-processor",
  brokers: KAFKA_BROKERS,
  logLevel: logLevel.WARN,
  retry: {
    initialRetryTime: 300,
    retries: 10,
  },
});

let consumer: Consumer;

/**
 * Creates and connects a Kafka consumer, subscribes to the telemetry topic,
 * and begins processing messages using the provided handler.
 */
export async function startConsumer(
  handler: (payload: EachMessagePayload) => Promise<void>
): Promise<void> {
  consumer = kafka.consumer({
    groupId: CONSUMER_GROUP,
    sessionTimeout: 30_000,
    heartbeatInterval: 3_000,
  });

  await consumer.connect();
  console.log(`[KAFKA] ✓ Consumer connected (group: ${CONSUMER_GROUP})`);

  await consumer.subscribe({
    topic: KAFKA_TOPIC,
    fromBeginning: false,
  });
  console.log(`[KAFKA] ✓ Subscribed to topic: ${KAFKA_TOPIC}`);

  await consumer.run({
    // Process one message at a time for guaranteed ordering per partition
    autoCommit: true,
    autoCommitInterval: 5_000,
    eachMessage: async (payload) => {
      try {
        await handler(payload);
      } catch (err) {
        console.error(
          `[KAFKA] ✗ Error processing message (topic=${payload.topic}, ` +
            `partition=${payload.partition}, offset=${payload.message.offset}):`,
          err
        );
        // In production: push to a dead-letter queue or retry topic
        // For now, log and move on to avoid blocking the consumer
      }
    },
  });
}

/**
 * Gracefully disconnects the Kafka consumer.
 */
export async function stopConsumer(): Promise<void> {
  if (consumer) {
    console.log("[KAFKA] Disconnecting consumer…");
    await consumer.disconnect();
    console.log("[KAFKA] ✓ Consumer disconnected");
  }
}
