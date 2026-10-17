# Fleet Vision — TCP Server Deployment Guide (Option 1: systemd)

> **Target Instance**: AWS EC2 (`gps-testing` / Ubuntu 22.04 or 24.04 LTS)  
> **Service**: Teltonika TCP Ingestion Gateway (`apps/tcp-server`)  
> **Architecture**: Native Linux `systemd` Service with Kernel Socket Tuning  
> **Port**: TCP `:8500` (Direct Ingestion)

---

## 📌 Terminal Legend: Know Where to Run Each Command

Throughout this guide, look at the badge above each command:

- 💻 **`[LOCAL TERMINAL]`**: Run on your local Ubuntu desktop terminal (`yash@...:~$`)
- ☁️ **`[EC2 TERMINAL]`**: Run inside your EC2 SSH session (`ubuntu@ip-...:~$`)

---

## Phase 1: AWS Console Security Group Setup (1 min)

Before connecting to your instance, ensure traffic can reach it:

1. Open **AWS EC2 Console** → Instances → Select **`gps-testing`**.
2. Click the **Security** tab → Click the **Security groups** link.
3. Click **Edit inbound rules** and ensure these rules exist:

| Type | Protocol | Port Range | Source | Description |
|---|---|---|---|---|
| **SSH** | TCP | `22` | `My IP` (or `0.0.0.0/0`) | Secure SSH terminal access |
| **Custom TCP** | TCP | `8500` | `0.0.0.0/0` | **Teltonika GPS Ingestion Port** |

*(Do NOT expose Kafka :9092 or database ports to the internet!)*

---

## Phase 2: Connect to your EC2 Instance via SSH

💻 **`[LOCAL TERMINAL]`**

Open a terminal on your local machine where your `.pem` key file is saved:

```bash
# 1. Restrict private key permissions (required by SSH)
chmod 400 gps-testing.pem

# 2. Connect to your EC2 instance (replace with your instance's Public IPv4)
ssh -i "gps-testing.pem" ubuntu@<YOUR_EC2_PUBLIC_IP>
```

You are now in your ☁️ **`[EC2 TERMINAL]`** (`ubuntu@ip-...:~$`).

---

## Phase 3: Install Required Software on EC2 (2 mins)

☁️ **`[EC2 TERMINAL]`**

Update the OS and install **Docker, Go, and network diagnostics**:

```bash
# 1. Update system packages
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget git build-essential ufw net-tools

# 2. Install Docker & Docker Compose plugin (Kafka runs in Docker)
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker $USER

# 3. Install Go compiler (to build the TCP server)
sudo apt install -y golang-go
```

> **Note**: Disconnect (`exit`) and SSH back in so your user can run `docker` commands without `sudo`.
> ```bash
> exit
> ssh -i "gps-testing.pem" ubuntu@<YOUR_EC2_PUBLIC_IP>
> ```

---

## Phase 4: Transfer / Clone `fleet-vision` Code to EC2

Choose **Option A** (Git) or **Option B** (Direct Copy):

### Option A: Clone from Git Repository
☁️ **`[EC2 TERMINAL]`**
```bash
cd /home/ubuntu
git clone <YOUR_GIT_REPO_URL> fleet-vision
cd /home/ubuntu/fleet-vision
```

### Option B: Copy from Local Computer via `rsync`
💻 **`[LOCAL TERMINAL]`** (Run from your local computer terminal)
```bash
rsync -avz --exclude 'node_modules' --exclude '.next' --exclude 'dist' \
  -e "ssh -i /path/to/gps-testing.pem" \
  /home/yash/Desktop/projects/fleet-vision/ ubuntu@<YOUR_EC2_PUBLIC_IP>:/home/ubuntu/fleet-vision/
```

---

## Phase 5: Start Kafka Infrastructure

The Go TCP Gateway publishes incoming device packets to Kafka on `localhost:9092`. Kafka must be running.

☁️ **`[EC2 TERMINAL]`**

```bash
cd /home/ubuntu/fleet-vision

# Start Kafka, TimescaleDB, and Redis in background
docker compose up -d

# Verify all containers are running and healthy
docker compose ps
```
Make sure `fv-kafka` is in `running` or `healthy` state.

---

## Phase 6: Tune Linux Kernel for High TCP Concurrency

By default, Linux limits processes to 1,024 open sockets. For high-volume GPS trackers, tune the OS TCP buffers and file descriptors.

☁️ **`[EC2 TERMINAL]`**

```bash
sudo bash -c 'cat << "EOF" > /etc/sysctl.d/99-telematics.conf
# Increase max open files system-wide
fs.file-max = 2097152

# Increase connection backlog queue for bursts of GPS tracker pings
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535

# Enable TCP SYN cookies for DDoS defense
net.ipv4.tcp_syncookies = 1

# Reuse TIME_WAIT sockets for outgoing Kafka connections
net.ipv4.tcp_tw_reuse = 1

# Reduce TCP keepalive timeout (detect dead trackers faster)
net.ipv4.tcp_keepalive_time = 600
net.ipv4.tcp_keepalive_intvl = 60
net.ipv4.tcp_keepalive_probes = 5

# High-throughput TCP buffer sizes
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216
EOF'

# Apply settings immediately
sudo sysctl --system
```

---

## Phase 7: Create Production Directories & System User

Never run socket services as `root`. We create a dedicated service user `tcpuser` and standard `/opt/fleet-vision` directory:

☁️ **`[EC2 TERMINAL]`**

```bash
# 1. Create system user with no interactive login
sudo useradd -r -s /bin/false -d /opt/fleet-vision tcpuser 2>/dev/null || true

# 2. Create production directories
sudo mkdir -p /opt/fleet-vision/bin
sudo mkdir -p /opt/fleet-vision/logs

# 3. Set ownership
sudo chown -R tcpuser:tcpuser /opt/fleet-vision
```

---

## Phase 8: Compile the Go Production Binary

Build a stripped, statically-linked Linux binary:

☁️ **`[EC2 TERMINAL]`**

```bash
cd /home/ubuntu/fleet-vision/apps/tcp-server

# Compile production binary (-s -w removes debug symbols, reducing size to ~12MB)
CGO_ENABLED=0 go build -ldflags="-s -w" -o dist/tcp-server .

# Install binary to production path
sudo cp dist/tcp-server /opt/fleet-vision/bin/tcp-server
sudo chmod +x /opt/fleet-vision/bin/tcp-server
sudo chown tcpuser:tcpuser /opt/fleet-vision/bin/tcp-server
```

---

## Phase 9: Create and Enable the `systemd` Service

Create `/etc/systemd/system/fleet-tcp.service`:

☁️ **`[EC2 TERMINAL]`**

```bash
sudo bash -c 'cat << "EOF" > /etc/systemd/system/fleet-tcp.service
[Unit]
Description=Fleet Vision Teltonika TCP Gateway
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
User=tcpuser
Group=tcpuser
WorkingDirectory=/opt/fleet-vision

# Executable binary
ExecStart=/opt/fleet-vision/bin/tcp-server

# Environment configuration
Environment=TCP_PORT=8500
Environment=KAFKA_BROKERS=localhost:9092
Environment=KAFKA_TOPIC=telemetry-raw

# Auto-recovery: restarts automatically if the process exits or crashes
Restart=always
RestartSec=3s
KillMode=mixed
TimeoutStopSec=15s

# Max open file descriptors (Sockets) - supports up to 1,000,000 simultaneous connections
LimitNOFILE=1048576
LimitNPROC=512000

# Security Sandboxing
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
ReadWritePaths=/opt/fleet-vision

# Logging to systemd journal
StandardOutput=journal
StandardError=journal
SyslogIdentifier=fleet-tcp

[Install]
WantedBy=multi-user.target
EOF'
```

Now reload and start the service:

☁️ **`[EC2 TERMINAL]`**

```bash
# 1. Reload systemd daemon
sudo systemctl daemon-reload

# 2. Enable automatic startup on server boot
sudo systemctl enable fleet-tcp

# 3. Start the service
sudo systemctl start fleet-tcp
```

---

## Phase 10: Verify and Test the Deployment

### 1. Check Service Status
☁️ **`[EC2 TERMINAL]`**
```bash
sudo systemctl status fleet-tcp
```
Expected output:
```text
● fleet-tcp.service - Fleet Vision Teltonika TCP Gateway
     Loaded: loaded (/etc/systemd/system/fleet-tcp.service; enabled; preset: enabled)
     Active: active (running) since ...
```

### 2. Verify Port 8500 is Listening
☁️ **`[EC2 TERMINAL]`**
```bash
sudo ss -tulpn | grep 8500
```
Expected output:
```text
tcp   LISTEN 0   4096   *:8500   *:*   users:(("tcp-server",pid=...,fd=3))
```

### 3. Stream Live Logs
☁️ **`[EC2 TERMINAL]`**
```bash
sudo journalctl -u fleet-tcp -f
```
Expected log output:
```text
┌──────────────────────────────────────────────┐
│        Fleet Vision · TCP Gateway            │
├──────────────────────────────────────────────┤
│  TCP Port    : 8500                          │
│  Kafka       : localhost:9092                │
│  Topic       : telemetry-raw                 │
└──────────────────────────────────────────────┘
[TCP] Listening on :8500 for Teltonika devices…
```

### 4. Test Connectivity from your Local Machine
💻 **`[LOCAL TERMINAL]`**
```bash
nc -zv <YOUR_EC2_PUBLIC_IP> 8500
```
If successful, it returns:
```text
Connection to <YOUR_EC2_PUBLIC_IP> 8500 port [tcp/*] succeeded!
```

---

## 🛠️ Everyday Operations & Management

All commands run in ☁️ **`[EC2 TERMINAL]`**:

| Action | Command |
|---|---|
| **View Live Logs** | `sudo journalctl -u fleet-tcp -f` |
| **Check Status** | `sudo systemctl status fleet-tcp` |
| **Restart Service** | `sudo systemctl restart fleet-tcp` |
| **Stop Service** | `sudo systemctl stop fleet-tcp` |
| **Start Service** | `sudo systemctl start fleet-tcp` |

### One-Line Command to Deploy Future Code Updates:
Whenever you make changes to `apps/tcp-server`, deploy the update with this single command:
```bash
cd /home/ubuntu/fleet-vision/apps/tcp-server && \
git pull origin main && \
CGO_ENABLED=0 go build -ldflags="-s -w" -o dist/tcp-server . && \
sudo cp dist/tcp-server /opt/fleet-vision/bin/tcp-server && \
sudo systemctl restart fleet-tcp && \
sudo journalctl -u fleet-tcp -n 20 --no-pager
```
