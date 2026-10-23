# ─── Builder Stage ───
FROM golang:1.23-alpine AS builder

WORKDIR /app

# Download dependencies first for optimal Docker layer caching
COPY apps/tcp-server/go.mod apps/tcp-server/go.sum ./
RUN go mod download

# Copy source code
COPY apps/tcp-server/ ./

# Ensure dependencies are tidied and compile statically-linked Linux binary
RUN go mod tidy && CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /app/bin/tcp-server .

# ─── Production Runner Stage ───
FROM alpine:3.20 AS runner

# Install runtime dependencies (ca-certificates for TLS, tzdata for timestamps, wget for healthcheck)
RUN apk --no-cache add ca-certificates tzdata wget

# Create unprivileged system user for sandboxing
RUN adduser -D -u 10001 -s /bin/false tcpuser

WORKDIR /app

# Copy compiled binary from builder
COPY --from=builder /app/bin/tcp-server /app/tcp-server

# Switch to non-root user
USER tcpuser

# 8500: Teltonika TCP Ingestion | 8501: Health check HTTP
EXPOSE 8500 8501

ENV TCP_PORT=8500 \
    HEALTH_PORT=8501 \
    KAFKA_BROKERS=localhost:9092 \
    KAFKA_TOPIC=telemetry-raw

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8501/healthz || exit 1

ENTRYPOINT ["/app/tcp-server"]
