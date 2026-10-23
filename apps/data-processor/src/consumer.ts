import {
  Kafka,
  Consumer,
  EachBatchPayload,
  logLevel,
  SASLOptions,
} from "kafkajs";
import { generateAuthToken } from "aws-msk-iam-sasl-signer-js";

// ─── Configuration ───────────────────────────────────────────

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || "localhost:9092").split(",");
const KAFKA_TOPIC = process.env.KAFKA_TOPIC || "telemetry-raw";
const CONSUMER_GROUP = process.env.CONSUMER_GROUP || "data-processor-group";

function extractAwsRegion(brokers: string[]): string {
  if (process.env.AWS_REGION) return process.env.AWS_REGION;
  if (process.env.AWS_DEFAULT_REGION) return process.env.AWS_DEFAULT_REGION;
  for (const b of brokers) {
    const match = b.match(/\.([a-z]{2}-[a-z]+-\d+)\.amazonaws\.com/i);
    if (match) return match[1];
  }
  return "ap-south-1";
}

const isMskIam =
  process.env.KAFKA_SASL_MECHANISM === "AWS_MSK_IAM" ||
  process.env.KAFKA_SASL_MECHANISM === "OAUTHBEARER" ||
  KAFKA_BROKERS.some((b) => b.includes(":9098") || b.includes("kafka-serverless"));

const useTLS =
  isMskIam ||
  process.env.KAFKA_USE_TLS === "true" ||
  process.env.KAFKA_SSL === "true" ||
  KAFKA_BROKERS.some((b) => b.includes(":9094") || b.includes(":9098") || b.includes(":443"));

const saslUser = process.env.KAFKA_SASL_USER;
const saslPass = process.env.KAFKA_SASL_PASS;
const saslMech = (process.env.KAFKA_SASL_MECHANISM || "plain").toLowerCase();

let saslConfig: SASLOptions | undefined = undefined;

if (isMskIam) {
  const region = extractAwsRegion(KAFKA_BROKERS);
  console.log(`[KAFKA] AWS MSK IAM authentication enabled (region: ${region})`);
  saslConfig = {
    mechanism: "oauthbearer",
    oauthBearerProvider: async () => {
      const authTokenResponse = await generateAuthToken({ region });
      return {
        value: authTokenResponse.token,
      };
    },
  };
} else if (saslUser && saslPass) {
  saslConfig = {
    mechanism: saslMech as any,
    username: saslUser,
    password: saslPass,
  };
}

// ─── Kafka Client ────────────────────────────────────────────

const kafka = new Kafka({
  clientId: "fleet-vision-data-processor",
  brokers: KAFKA_BROKERS,
  ssl: useTLS ? true : undefined,
  sasl: saslConfig,
  logLevel: logLevel.WARN,
  retry: {
    initialRetryTime: 300,
    retries: 10,
  },
});

let consumer: Consumer;

/**
 * Creates and connects a Kafka consumer, subscribes to the telemetry topic,
 * and begins processing messages in batches using the provided handler.
 *
 * Uses eachBatch for higher throughput as specified in the master plan.
 */
export async function startConsumer(
  batchHandler: (
    messages: Array<{ value: Buffer | null }>
  ) => Promise<void>
): Promise<void> {
  consumer = kafka.consumer({
    groupId: CONSUMER_GROUP,
    sessionTimeout: 30_000,
    heartbeatInterval: 3_000,
  });

  // Ensure topic exists before subscribing
  const admin = kafka.admin();
  try {
    await admin.connect();
    const existingTopics = await admin.listTopics();
    if (!existingTopics.includes(KAFKA_TOPIC)) {
      await admin.createTopics({
        topics: [{ topic: KAFKA_TOPIC, numPartitions: 1, replicationFactor: 1 }],
      });
      console.log(`[KAFKA] ✓ Topic "${KAFKA_TOPIC}" created successfully`);
    }
  } catch (adminErr) {
    console.warn(`[KAFKA] Admin check for topic notice:`, adminErr);
  } finally {
    await admin.disconnect().catch(() => {});
  }

  await consumer.connect();
  console.log(`[KAFKA] ✓ Consumer connected (group: ${CONSUMER_GROUP})`);

  await consumer.subscribe({
    topic: KAFKA_TOPIC,
    fromBeginning: false,
  });
  console.log(`[KAFKA] ✓ Subscribed to topic: ${KAFKA_TOPIC}`);

  await consumer.run({
    // Process messages in batches for higher throughput
    eachBatch: async ({ batch, heartbeat, resolveOffset, commitOffsetsIfNecessary }: EachBatchPayload) => {
      const messages = batch.messages.map((m) => ({
        value: m.value,
      }));

      if (messages.length === 0) return;

      try {
        await batchHandler(messages);

        // Mark all offsets as resolved
        for (const message of batch.messages) {
          resolveOffset(message.offset);
        }
        await commitOffsetsIfNecessary();
        await heartbeat();
      } catch (err) {
        console.error(
          `[KAFKA] ✗ Error processing batch (topic=${batch.topic}, ` +
            `partition=${batch.partition}, messages=${messages.length}):`,
          err
        );
        // In production: push to a dead-letter queue or retry topic
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
