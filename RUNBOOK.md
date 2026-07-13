# Fleet Vision - How to Run the Project

This guide provides a detailed, step-by-step plan to start the Fleet Vision telematics platform from scratch.

## Prerequisites

Before starting, ensure you have the following installed on your machine:
1.  **Docker Desktop** (Required for PostgreSQL and Kafka)
2.  **Node.js** (v18 or higher)
3.  **Go** (v1.21 or higher)

---

## Step 1: Start Docker Desktop

The project relies on Docker to run PostgreSQL (database) and Kafka (message broker).

1.  Open the Start Menu in Windows.
2.  Search for **Docker Desktop** and open it.
3.  Wait until the Docker icon in your system tray (bottom right corner) turns green or indicates that the "Docker Engine is running".
4.  *Note: If you encounter an error stating `open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified`, it means Docker Desktop has not fully started yet.*

---

## Step 2: Start Infrastructure Containers

Once Docker Desktop is running, you need to spin up the required infrastructure (PostgreSQL and Kafka).

1.  Open a terminal in the root of the project (`fleet-vision`).
2.  Run the following command:
    ```bash
    npm run infra:up
    ```
3.  This command runs `docker compose up -d` in the background, downloading and starting the PostgreSQL and Kafka containers.
4.  To verify they are running, you can use:
    ```bash
    docker ps
    ```
    You should see `fv-postgres` and `fv-kafka` listed and healthy.

---

## Step 3: Initialize the Database

With PostgreSQL running, you need to push the Prisma schema to create the necessary tables (`devices` and `telemetry_records`).

1.  In your terminal at the project root, run:
    ```bash
    npm run db:push
    ```
2.  Prisma will connect to the database (using the `DATABASE_URL` in your `.env` file) and synchronize the schema.

---

## Step 4: Start the Application Services

The platform consists of three main services. You should open **three separate terminal windows** (all navigated to the `fleet-vision` root directory) to run them concurrently, allowing you to monitor their logs.

### Terminal 1: Start the Go TCP Gateway
This service listens for incoming connections from your Teltonika devices.
```bash
npm run dev:tcp
```
*Expected Output: You will see it listening on port 8500.*

### Terminal 2: Start the Data Processor
This service consumes messages from Kafka and writes them to the PostgreSQL database.
```bash
npm run dev:processor
```
*Expected Output: You will see it connect to PostgreSQL and subscribe to the Kafka topic.*

### Terminal 3: Start the Web Dashboard (Optional)
If you want to view the Next.js frontend application.
```bash
npm run dev:dashboard
```
*Expected Output: The Next.js app will be available at `http://localhost:3000`.*

*(Shortcut: Alternatively, you can run `npm run dev:all` in a single terminal to start all three, but keeping them separate makes it easier to read logs).*

---

## Step 5: View Your Data

You can use Prisma Studio, a visual database browser, to inspect the incoming data.

1.  Open a new terminal at the project root.
2.  Run:
    ```bash
    npm run db:studio
    ```
3.  This will open Prisma Studio in your web browser (usually at `http://localhost:5555`), allowing you to view the `devices` and `telemetry_records` tables.

---

## Step 6: Connect Your FMC130 Device

To send real data to your locally running server:

1.  Find your computer's local IP address on your network by opening a command prompt and running `ipconfig` (look for IPv4 Address, e.g., `192.168.1.50`).
2.  Connect your FMC130 device to your computer via USB.
3.  Open the **Teltonika Configurator**.
4.  Navigate to the **GPRS** section -> **Server Settings**.
5.  Set the following:
    *   **Domain:** Your local IP address (e.g., `192.168.1.50`)
    *   **Port:** `8500`
    *   **Protocol:** `TCP`
6.  Click **Save to device**.

*Note: If your device uses mobile data, it must be on the same network as your computer, OR you must configure port forwarding on your router to expose port 8500 to the internet.*

---

## Stopping the Project

When you are done, you can stop the services by pressing `Ctrl+C` in their respective terminal windows.
To stop the Docker infrastructure, run:
```bash
npm run infra:down
```
