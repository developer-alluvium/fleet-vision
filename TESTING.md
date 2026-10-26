# Fleet Vision – Enterprise QA & Testing Master Guide

> **Target Frontend Application:** [https://fleetvision.alvision.in/](https://fleetvision.alvision.in/)  
> **Backend Swagger API Documentation:** [https://fleetvision.alvision.in/doc](https://fleetvision.alvision.in/doc)  
> **OpenAPI 3.0 Raw Specification:** [https://fleetvision.alvision.in/api/openapi.json](https://fleetvision.alvision.in/api/openapi.json)  
> **Date of Release:** October 2026  
> **Document Purpose:** Comprehensive End-to-End (E2E), Manual, Functional, API, Performance, Security, and Cross-Platform QA Test Plan for the Testing Team.

---

## Table of Contents
1. [Executive Summary & Test Strategy](#1-executive-summary--test-strategy)
2. [Test Environment & QA Prerequisites](#2-test-environment--qa-prerequisites)
3. [System Architecture & Data Flow Overview](#3-system-architecture--data-flow-overview)
4. [Frontend Functional Test Suites (UI/UX)](#4-frontend-functional-test-suites-uiux)
   - [Suite 1: Authentication & Organization Onboarding](#suite-1-authentication--organization-onboarding)
   - [Suite 2: Fleet Status Dashboard HUD (`/`)](#suite-2-fleet-status-dashboard-hud-)
   - [Suite 3: Live Vehicle Tracking & Real-Time Map (`/all-vehicles`)](#suite-3-live-vehicle-tracking--real-time-map-all-vehicles)
   - [Suite 4: Fleet Directory Management (`/directory`)](#suite-4-fleet-directory-management-directory)
     - [Sub-Suite 4A: Vehicle Catalog & Fuel Calibration](#sub-suite-4a-vehicle-catalog--fuel-calibration)
     - [Sub-Suite 4B: Telemetry Device Hardware (IMEI)](#sub-suite-4b-telemetry-device-hardware-imei)
   - [Suite 5: Trip History, Track Replay & PDF Audit (`/history`)](#suite-5-trip-history-track-replay--pdf-audit-history)
   - [Suite 6: Geofence Zone Management (`/geofences`)](#suite-6-geofence-zone-management-geofences)
   - [Suite 7: Real-Time Alerts Center (`/alerts`)](#suite-7-real-time-alerts-center-alerts)
   - [Suite 8: Fleet Utilization Analytics (`/utilization`)](#suite-8-fleet-utilization-analytics-utilization)
   - [Suite 9: Fuel Analytics & Drain Detection (`/fuel`)](#suite-9-fuel-analytics--drain-detection-fuel)
   - [Suite 10: API Keys & Organization Profile (`/settings`)](#suite-10-api-keys--organization-profile-settings)
5. [Backend Swagger API Test Suite (`/doc`)](#5-backend-swagger-api-test-suite-doc)
6. [Real-Time Streaming & Server-Sent Events (SSE) Validation](#6-real-time-streaming--server-sent-events-sse-validation)
7. [Security, Access Control & Multi-Tenancy Validation](#7-security-access-control--multi-tenancy-validation)
8. [Cross-Browser, Responsive & Performance Testing](#8-cross-browser-responsive--performance-testing)
9. [Defect Reporting Guidelines & Bug Template](#9-defect-reporting-guidelines--bug-template)
10. [QA Sign-Off Checklist](#10-qa-sign-off-checklist)

---

## 1. Executive Summary & Test Strategy

**Fleet Vision** is an enterprise-grade IoT telematics and real-time fleet management platform. It ingests high-frequency GPS, speed, ignition, and fuel sensor telemetry from vehicle-mounted hardware tracking units (via TCP), processes telemetry through a distributed pipeline, and surfaces sub-second operational dashboards, geofencing violations, audit reports, and live map playback to fleet operators.

### Testing Scope
- **Frontend Web Portal:** Modern Next.js 16 (App Router), React 19, Leaflet/Mapbox maps, Server-Sent Events (SSE), and Tailwind CSS v4.
- **Backend API Gateway:** High-performance RESTful API endpoints, OpenAPI/Swagger interactive UI, JWT/HttpOnly session handling, and API key authentication.
- **Data Streaming & Telematics:** Sub-second live updates, connection reconnection resiliency, downsampled historical breadcrumb interpolation, and PDF export.

### QA Priority Matrix
| Priority | Definition | Examples |
| :--- | :--- | :--- |
| **P0 (Blocker)** | Core feature unavailable; application crashes; data loss; security breach. | Cannot log in; SSE stream fails to deliver vehicle coords; live map blank. |
| **P1 (Critical)** | Major business functionality impaired with no viable workaround. | Geofence enter/exit not firing; fuel calibration saves invalid table; PDF report fails to generate. |
| **P2 (Major)** | Secondary functionality broken; layout broken on supported browser. | Filter by date range does not clear; theme toggle resets on refresh; table sorting glitch. |
| **P3 (Minor)** | Cosmetic defect, spelling error, minor styling misalignment. | Button padding 2px off; typography inconsistency; icon misaligned. |

---

## 2. Test Environment & QA Prerequisites

### 2.1 URLs & Access Points
| Environment | URL | Notes |
| :--- | :--- | :--- |
| **Frontend Portal** | `https://fleetvision.alvision.in/` | Primary user dashboard |
| **Swagger API Docs**| `https://fleetvision.alvision.in/doc` | Interactive Swagger UI testing console |
| **OpenAPI 3.0 Spec**| `https://fleetvision.alvision.in/api/openapi.json` | Direct raw schema for Postman import |
| **Login Route** | `https://fleetvision.alvision.in/login` | Session login |
| **Registration** | `https://fleetvision.alvision.in/register-organization` | Organization onboarding |

### 2.2 Recommended QA Tools
- **Browsers:** Google Chrome (Latest), Mozilla Firefox (Latest), Apple Safari (iOS & macOS), Microsoft Edge.
- **API Clients:** Postman, Insomnia, or cURL.
- **Network Tools:** Chrome DevTools -> **Network Tab** (filter by `Fetch/XHR` and `EventStream`), DevTools Console, Network Throttling (Slow 3G, Offline).
- **Screen Capture:** Loom, Snagit, or Chrome native full-page screenshot for bug attachments.

### 2.3 Sample Test Data Preparation
Prepare the following dummy data sets before commencing test execution:
- **Test Organization Name:** `QA Logistics Corp [Timestamp]`
- **Admin Email:** `qa.admin.<timestamp>@testfleet.com`
- **Admin Password:** `FleetVision@2026#Secure`
- **Test Vehicle 1 (Truck):** Plate `MH-12-QA-1001`, Make `Tata`, Model `Prima 5530`, VIN `1TATAPRIMAA1001QA`, Type `Heavy Truck`
- **Test Vehicle 2 (Van):** Plate `MH-14-QA-2002`, Make `Mahindra`, Model `Bolero Maxi`, VIN `2MAHINDRAB2002QA`, Type `Light Commercial`
- **Test Device IMEI 1:** `868204050001001` (15 digits numeric)
- **Test Device IMEI 2:** `868204050002002` (15 digits numeric)
- **Geofence Center:** Latitude `19.0760`, Longitude `72.8777` (Mumbai Central Depot), Radius `1500m`

---

## 3. System Architecture & Data Flow Overview

```
 ┌────────────────────────────────────────────────────────────────────────┐
 │                      FLEET VISION TELEMATICS PIPELINE                  │
 └────────────────────────────────────────────────────────────────────────┘
                                     │
      ┌──────────────────────────────┴──────────────────────────────┐
      ▼                                                             ▼
 ┌──────────────────────────────────────┐     ┌──────────────────────────────────────┐
 │     Frontend Web Portal (`/`)        │     │    Backend Gateway & Swagger (`/doc`)│
 │  • Real-time SSE event consumption   │     │  • Secure JWT / HttpOnly Cookie      │
 │  • Leaflet Vector Map Visualization  │◄────┤  • Organization Tenancy Filter       │
 │  • Piecewise Fuel Calibration Modal  │     │  • TimescaleDB Telemetry Queries     │
 │  • Canvas Scrubber & PDF Engine      │     │  • Geofence Ray-Casting & Alerts     │
 └──────────────────▲───────────────────┘     └──────────────────▲───────────────────┘
                    │                                            │
                    └─────────────────────┬──────────────────────┘
                                          │
                               ┌──────────┴──────────┐
                               ▼                     ▼
                       ┌───────────────┐     ┌───────────────┐
                       │ Redis Pub/Sub │     │  TimescaleDB  │
                       │ Live Telemetry│     │Historical Logs│
                       └───────────────┘     └───────────────┘
```

---

## 4. Frontend Functional Test Suites (UI/UX)

---

### Suite 1: Authentication & Organization Onboarding

#### TC-AUTH-01: New Organization Onboarding & Root Admin Creation
- **Target URL:** `https://fleetvision.alvision.in/register-organization`
- **Priority:** P0 (Blocker)
- **Preconditions:** Unauthenticated browser session.
- **Steps:**
  1. Navigate to `/register-organization`.
  2. Enter valid details:
     - Organization Name: `Global Freight Express`
     - Contact Email: `admin@globalfreight.io`
     - Contact Phone: `+919876543210`
     - Admin First Name: `Fleet`
     - Admin Last Name: `Director`
     - Password: `Password@1234`
  3. Click **"Register Organization"**.
- **Expected Results:**
  - Form validates successfully without client-side error.
  - Server returns HTTP 201 Created with organization ID and user record.
  - User is immediately issued HttpOnly cookies or redirected to `/login` with success banner.

#### TC-AUTH-02: Organization User Login
- **Target URL:** `https://fleetvision.alvision.in/login`
- **Priority:** P0 (Blocker)
- **Steps:**
  1. Navigate to `/login`.
  2. Input registered Email and Password.
  3. Click **"Sign In"**.
- **Expected Results:**
  - Spinner displays during request processing.
  - API call `POST /api/v1/auth/login` returns HTTP 200 with user data.
  - Secure HttpOnly cookies (`access_token`, `refresh_token`) are established in browser storage.
  - User is redirected to `/` (Dashboard Overview).
  - User organization name and avatar appear in the sidebar/topbar.

#### TC-AUTH-03: Invalid Credentials & Error Handling
- **Target URL:** `https://fleetvision.alvision.in/login`
- **Priority:** P1 (Critical)
- **Steps:**
  1. Input non-existent email or wrong password.
  2. Submit form.
- **Expected Results:**
  - No crash or blank screen.
  - UI displays an error alert: *"Invalid email or password"*.
  - Password input is cleared; user remains on `/login`.

#### TC-AUTH-04: Session Persistence & Token Refresh
- **Priority:** P1 (Critical)
- **Steps:**
  1. Log in successfully.
  2. Refresh the browser tab (F5 / Cmd+R).
  3. Open a new tab and navigate to `https://fleetvision.alvision.in/all-vehicles`.
  4. Leave page idle for 15 minutes or manually trigger token expiration.
- **Expected Results:**
  - Session remains active; user is NOT logged out on page refresh.
  - `GET /api/v1/auth/me` validates session seamlessly.
  - Silent token refresh executes via `POST /api/v1/auth/refresh` without user interruption.

#### TC-AUTH-05: Secure Logout & Route Protection
- **Priority:** P1 (Critical)
- **Steps:**
  1. While logged in, click **"Log Out"** in the sidebar.
  2. Observe redirection to `/login`.
  3. Click the browser's **Back** button.
  4. Directly attempt to access `https://fleetvision.alvision.in/directory`.
- **Expected Results:**
  - `POST /api/v1/auth/logout` clears HttpOnly cookies.
  - User cannot navigate back into authenticated views; edge proxy redirects unauthenticated requests immediately to `/login`.

---

### Suite 2: Fleet Status Dashboard HUD (`/`)

#### TC-DASH-01: Real-Time Vehicle Status Counters
- **Target URL:** `https://fleetvision.alvision.in/`
- **Priority:** P1 (Critical)
- **Steps:**
  1. Log in and open Dashboard overview.
  2. Inspect the 4 primary metric cards:
     - **Running** (Green)
     - **Idle** (Yellow/Orange)
     - **Stopped** (Blue)
     - **Inactive** (Red/Muted)
  3. Cross-reference sum of status counts against total registered fleet count.
- **Expected Results:**
  - Sum of Running + Idle + Stopped + Inactive equals total active fleet.
  - Metric numbers reflect live SSE stream payload (`/api/v1/stream/fleet-status`).

#### TC-DASH-02: SSE Live Stream Connection Health Indicator
- **Priority:** P1 (Critical)
- **Steps:**
  1. Observe the top-right live connection pill on the dashboard.
  2. Open DevTools -> Network -> throttle to **Offline**.
  3. Observe status pill change.
  4. Restore network to **Online**.
- **Expected Results:**
  - Online state displays *"Live Telematics Connected"* (Green pulse dot).
  - Offline state displays *"Reconnecting..."* or *"Offline"* (Amber/Red).
  - Restoring connectivity automatically reconnects EventSource without requiring page refresh.

#### TC-DASH-03: Fuel Distribution Bands Chart
- **Priority:** P2 (Major)
- **Steps:**
  1. Review the Fuel Distribution Section.
  2. Check the 5 fuel ranges:
     - Critical (<20L)
     - Low (20–50L)
     - Medium (50–100L)
     - Good (100–200L)
     - Full (200L+)
- **Expected Results:**
  - Donut/bar percentages add up to 100%.
  - Hovering over segments reveals exact vehicle counts and percentages.

#### TC-DASH-04: Theme Toggle (Dark / Light Mode)
- **Priority:** P3 (Minor)
- **Steps:**
  1. Click the Sun/Moon theme toggle icon in the sidebar or top bar.
  2. Verify all surfaces, cards, text colors, and borders adjust smoothly.
  3. Refresh the page.
- **Expected Results:**
  - High-contrast, polished dark mode with glassmorphic cards and crisp typography.
  - Theme preference persists across browser refreshes via localStorage.

---

### Suite 3: Live Vehicle Tracking & Real-Time Map (`/all-vehicles`)

#### TC-LIVE-01: Map Tile Rendering & Live Vehicle Pins
- **Target URL:** `https://fleetvision.alvision.in/all-vehicles`
- **Priority:** P0 (Blocker)
- **Steps:**
  1. Navigate to `/all-vehicles`.
  2. Verify map tiles load (OpenStreetMap/Carto/Mapbox).
  3. Check vehicle markers on the map.
- **Expected Results:**
  - No gray or missing map tiles.
  - Vehicle markers render at their respective GPS coordinates.
  - Vehicle marker color matches its status (Moving = Green, Idle = Amber, Stopped = Blue).
  - Vehicle bearing/heading indicator points in the correct direction of movement.

#### TC-LIVE-02: View Mode Switching (Split / Map Only / Table Only)
- **Priority:** P2 (Major)
- **Steps:**
  1. Click the **View Mode** toggles:
     - **Split View:** Map on left/top, vehicle list on right/bottom.
     - **Map View:** Full-screen interactive map.
     - **Table View:** Dense data table with search, plate number, speed, last ping.
- **Expected Results:**
  - Layout transitions smoothly without map re-initialization flickers.
  - Map auto-resizes to fill container without distortion.

#### TC-LIVE-03: Live SSE Movement & Telemetry Updates
- **Priority:** P0 (Blocker)
- **Steps:**
  1. Open Network Tab -> filter `EventStream`.
  2. Inspect connection to `/api/v1/stream/devices` or `/api/v1/stream/fleet`.
  3. When telemetry packet arrives from TCP server / simulator:
     - Observe vehicle coordinate updates on map.
     - Observe speed indicator update in real time.
- **Expected Results:**
  - Vehicle pin moves smoothly to new position without full page reload.
  - Speedometer and status badges update dynamically.

#### TC-LIVE-04: Status Filtering (All, Running, Idle, Stopped, Inactive)
- **Priority:** P1 (Critical)
- **Steps:**
  1. Use the Status dropdown filter to select **"Running"**.
  2. Observe map pins and side list.
  3. Select **"Stopped"**.
  4. Select **"All"**.
- **Expected Results:**
  - Map and list filter instantaneously.
  - URL query parameter updates to `?status=running` (shareable link).

#### TC-LIVE-05: Vehicle Pin Click & Telemetry Inspector
- **Priority:** P1 (Critical)
- **Steps:**
  1. Click on any vehicle marker on the map or in the side list.
- **Expected Results:**
  - Map smoothly pans and centers on the selected vehicle.
  - Detailed popup or drawer opens displaying:
    - Vehicle Plate Number & Model
    - Assigned Hardware IMEI
    - Current Speed (km/h) & Heading
    - Ignition Status (ON / OFF)
    - Calculated Fuel Level (Liters & %)
    - Timestamp of Last Telemetry Ping
    - Quick Action Button: **"View History / Replay"**

#### TC-LIVE-06: Geofence Overlay Toggle & On-Map Quick Drawing
- **Priority:** P2 (Major)
- **Steps:**
  1. Click **"Show Geofences"** checkbox/toggle.
  2. Observe geofence polygons/circles rendering on top of the live tracking map.
  3. Click **"New Geofence"** button on the map header.
- **Expected Results:**
  - Active geofence zones render with assigned color and transparency.
  - Clicking "New Geofence" activates drawing mode (polygon or circle) directly on the live tracking canvas.

---

### Suite 4: Fleet Directory Management (`/directory`)

---

#### Sub-Suite 4A: Vehicle Catalog & Fuel Calibration

#### TC-VEH-01: Vehicle Registration Modal
- **Target URL:** `https://fleetvision.alvision.in/directory?tab=vehicles`
- **Priority:** P0 (Blocker)
- **Steps:**
  1. Navigate to `/directory?tab=vehicles`.
  2. Click **"+ Add Vehicle"**.
  3. Fill out the form:
     - License Plate: `DL-01-AB-9988` (Required)
     - Make: `Volvo`
     - Model: `FH16`
     - Year: `2024`
     - Color: `Silver`
     - VIN: `YV2RT40A5MA123456`
     - Vehicle Type: `Heavy Commercial Truck`
  4. Click **"Save Vehicle"**.
- **Expected Results:**
  - Input validation confirms plate number format.
  - `POST /api/v1/vehicles` returns HTTP 201 Created.
  - New vehicle appears at top of the vehicle list.
  - Success toast modal appears.

#### TC-VEH-02: Duplicate Vehicle Plate Rejection
- **Priority:** P1 (Critical)
- **Steps:**
  1. Attempt to add another vehicle with the exact same license plate `DL-01-AB-9988`.
- **Expected Results:**
  - Request rejected with HTTP 409 Conflict or 400 Bad Request.
  - Clear user message: *"A vehicle with this plate number already exists."*

#### TC-VEH-03: Piecewise Fuel Calibration Table Editor
- **Priority:** P1 (Critical)
- **Steps:**
  1. In the Vehicles list, click the action menu (`...`) for any vehicle.
  2. Click **"Fuel Calibration"**.
  3. Inspect the Piecewise Calibration Modal:
     - Add calibration points:
       - Row 1: Sensor Value = `0`, Volume = `0 L` (Empty tank)
       - Row 2: Sensor Value = `500`, Volume = `150 L` (Half tank)
       - Row 3: Sensor Value = `1023`, Volume = `320 L` (Full tank)
     - Add a custom row and delete a row.
  4. Click **"Save Calibration Table"**.
- **Expected Results:**
  - Table enforces strictly ascending sensor values.
  - Validates non-negative volumes.
  - `POST /api/v1/vehicles/{id}/fuel-calibration-table` saves table.
  - Subsequent telemetry converts raw sensor value to liters using piecewise linear interpolation.

#### TC-VEH-04: Speed Limit Configuration (Global & Vehicle Specific)
- **Priority:** P2 (Major)
- **Steps:**
  1. In Vehicles tab, click **"Speed Limits"** or action menu -> **"Set Speed Limit"**.
  2. Set maximum allowable speed (e.g. `80 km/h`).
  3. Save.
- **Expected Results:**
  - Setting persists to vehicle record.
  - When telemetry speed exceeds configured limit, an overspeed alert triggers.

---

#### Sub-Suite 4B: Telemetry Device Hardware (IMEI)

#### TC-DEV-01: Register Hardware Tracker (15-Digit IMEI)
- **Target URL:** `https://fleetvision.alvision.in/directory?tab=devices`
- **Priority:** P0 (Blocker)
- **Steps:**
  1. Switch to **Devices** tab (`/directory?tab=devices`).
  2. Click **"+ Add Device"**.
  3. Enter 15-digit numeric IMEI: `868204050012345`.
  4. Submit.
- **Expected Results:**
  - Client validates that IMEI consists of exactly 15 numeric digits.
  - `POST /api/v1/devices` creates device with default status `INACTIVE` / `ONLINE`.
  - Device displays in inventory table.

#### TC-DEV-02: Invalid IMEI Format Rejection
- **Priority:** P2 (Major)
- **Steps:**
  1. Try entering `12345` (too short), `1234567890123456` (too long), or `86820405001234A` (alphanumeric).
- **Expected Results:**
  - Form validation prevents submission with message: *"IMEI must be a valid 15-digit number."*

#### TC-DEV-03: Assign Device to Vehicle & Unbind
- **Priority:** P0 (Blocker)
- **Steps:**
  1. Locate unassigned device `868204050012345`.
  2. Click **"Assign Vehicle"**.
  3. Select an unassigned vehicle from dropdown (`DL-01-AB-9988`).
  4. Confirm assignment.
  5. Verify vehicle table reflects assigned IMEI.
  6. Click **"Unassign"** and confirm.
- **Expected Results:**
  - Assignment executes via `POST /api/v1/devices/{id}/assign`.
  - Vehicle cannot be assigned to two active devices simultaneously.
  - Unassigning restores device to available inventory.

---

### Suite 5: Trip History, Track Replay & PDF Audit (`/history`)

#### TC-HIST-01: Query Historical Journey Trail
- **Target URL:** `https://fleetvision.alvision.in/history`
- **Priority:** P0 (Blocker)
- **Steps:**
  1. Navigate to `/history`.
  2. Select vehicle or enter device IMEI.
  3. Select time range preset: **1h**, **6h**, **24h**, or **3d**.
  4. Click **"Search / Load Journey"**.
- **Expected Results:**
  - `GET /api/v1/journey` fetches TimescaleDB breadcrumbs.
  - Map renders breadcrumb polyline route in high contrast.
  - Start marker (Green flag) and End marker (Checkered flag) display.
  - Summary cards show: Total Distance (km), Duration, Max Speed, Avg Speed, Idle Duration.

#### TC-HIST-02: Interactive Route Playback Scrubber
- **Priority:** P1 (Critical)
- **Steps:**
  1. On historical route map, locate playback toolbar at bottom.
  2. Click **Play** (`▶`).
  3. Move scrubber slider manually to 50% of the timeline.
  4. Toggle playback speed: **1x -> 2x -> 5x**.
  5. Click **Pause** (`⏸`).
- **Expected Results:**
  - Moving vehicle icon animates along the polyline path smoothly.
  - Dynamic HUD displays instantaneous speed, fuel, and timestamp corresponding to scrubber position.
  - Speed multiplier accelerates playback accurately without dropping animation frames.

#### TC-HIST-03: Download Trip Audit PDF Compliance Report
- **Priority:** P1 (Critical)
- **Steps:**
  1. Click **"Download Audit PDF"** button.
  2. Wait for client-side PDF generation (`generateHistoricalTrackPdf`).
  3. Open downloaded PDF document.
- **Expected Results:**
  - PDF downloads automatically named `Trip_Audit_<Plate>_<Date>.pdf`.
  - PDF contains:
    - Company Letterhead & Vehicle Details
    - Distance, Running Time, Stoppage Count
    - Formatted Table of Major Stoppages & Speed Violations
    - High-resolution map route snapshot

---

### Suite 6: Geofence Zone Management (`/geofences`)

#### TC-GEO-01: Create Polygon Geofence
- **Target URL:** `https://fleetvision.alvision.in/geofences`
- **Priority:** P1 (Critical)
- **Steps:**
  1. Navigate to `/geofences` and click **"+ Create Geofence"**.
  2. Select type: **Polygon**.
  3. Click points on map to draw a 4-point polygon around a warehouse.
  4. Enter details:
     - Name: `Bhiwandi Central Logistics Hub`
     - Color: `#3B82F6` (Blue)
     - Alert on Enter: `Checked`
     - Alert on Exit: `Checked`
     - Speed Limit in Zone: `30 km/h`
  5. Click **"Save Geofence"**.
- **Expected Results:**
  - Coordinates array is saved via `POST /api/v1/geofences`.
  - Polygon renders on map with selected color and opacity.
  - Geofence appears in left sidebar list.

#### TC-GEO-02: Create Circular Geofence
- **Priority:** P1 (Critical)
- **Steps:**
  1. Click **"+ Create Geofence"** -> Select **Circle**.
  2. Click center point on map; adjust radius slider to `1200 meters`.
  3. Name: `Port Container Terminal`.
  4. Save.
- **Expected Results:**
  - Circle renders accurately according to center coordinates and radius.
  - Saved with `type: "CIRCLE"`, `centerLat`, `centerLng`, `radiusMeters`.

#### TC-GEO-03: Geofence Point Testing Utility
- **Priority:** P2 (Major)
- **Steps:**
  1. Select a geofence and click **"Test Coordinates"**.
  2. Input coordinates inside the geofence -> Click Test.
  3. Input coordinates outside the geofence -> Click Test.
- **Expected Results:**
  - API call `POST /api/v1/geofences/{id}/test` returns `isInside: true` for inside coords and `false` for outside coords.

#### TC-GEO-04: Delete Geofence with Confirmation Modal
- **Priority:** P2 (Major)
- **Steps:**
  1. Click delete trash icon on a geofence.
  2. Verify confirmation modal prompts: *"Are you sure you want to delete this zone?"*
  3. Click Confirm.
- **Expected Results:**
  - Zone is deleted from backend (`DELETE /api/v1/geofences/{id}`).
  - Zone immediately disappears from map without full page refresh.

---

### Suite 7: Real-Time Alerts Center (`/alerts`)

#### TC-ALRT-01: Real-Time Alert Notification Toasts
- **Target URL:** `https://fleetvision.alvision.in/alerts`
- **Priority:** P0 (Blocker)
- **Steps:**
  1. Open any page in the portal (e.g. Dashboard or Live Map).
  2. Trigger a simulated alert (e.g. vehicle crosses geofence or overspeeds).
  3. Observe top-right notification banner (`AlertToaster.tsx`).
- **Expected Results:**
  - Toast banner slides in smoothly with alert sound/icon.
  - Displays alert category (Geofence Breach / Speed Violation), Vehicle Plate, and Timestamp.
  - Clicking toast navigates user directly to alert details or live vehicle map.

#### TC-ALRT-02: Filter & Audit Alert Records
- **Priority:** P1 (Critical)
- **Steps:**
  1. Navigate to `/alerts/all`.
  2. Test available filters:
     - **Category:** All, Geofence, Speeding, Ignition, Fuel
     - **Zone:** Filter by specific geofence
     - **Event Type:** `ENTER`, `EXIT`, `SPEED_VIOLATION`
     - **Date Range:** From date & To date
     - **Search:** Plate number or IMEI
- **Expected Results:**
  - Table filters dynamically and preserves query parameters in URL.
  - Correct badge colors (Red for Speed Violation, Amber for Exit, Blue for Enter).
  - Pagination works seamlessly (20 items per page).

---

### Suite 8: Fleet Utilization Analytics (`/utilization`)

#### TC-UTIL-01: Metric Aggregation Cards
- **Target URL:** `https://fleetvision.alvision.in/utilization`
- **Priority:** P1 (Critical)
- **Steps:**
  1. Navigate to `/utilization`.
  2. Review metric cards:
     - **Total Distance Traveled** (km)
     - **Total Engine Run Time** (hours/minutes)
     - **Total Idle Time** (hours/minutes)
     - **Estimated Fuel Consumed** (Liters)
- **Expected Results:**
  - Calculations match telemetry data aggregates.
  - No `NaN`, `null`, or `undefined` displayed.

#### TC-UTIL-02: Preset Ranges & Stacked Bar Charts
- **Priority:** P2 (Major)
- **Steps:**
  1. Toggle presets: **24h** (hourly buckets), **7d** (daily buckets), **30d** (daily buckets).
  2. Inspect stacked bar chart showing Running vs. Idle vs. Stopped hours.
- **Expected Results:**
  - Charts re-render cleanly upon preset switch.
  - Tooltip on bar hover shows exact breakdown of hours.

---

### Suite 9: Fuel Analytics & Drain Detection (`/fuel`)

#### TC-FUEL-01: Fuel Consumption Trends
- **Target URL:** `https://fleetvision.alvision.in/fuel`
- **Priority:** P1 (Critical)
- **Steps:**
  1. Open `/fuel`.
  2. Toggle group by: **Hour**, **Day**, **Week**.
- **Expected Results:**
  - Consumption curves show fuel trends across selected interval.
  - Refetch button re-syncs latest sensor data.

#### TC-FUEL-02: Fuel Drain & Theft Anomaly Event Feed
- **Priority:** P1 (Critical)
- **Steps:**
  1. Inspect the **Fuel Events Feed** panel.
  2. Look for rapid drop events (e.g. `> 15 Liters in 5 minutes with ignition OFF`).
- **Expected Results:**
  - Event highlights with Warning badge, vehicle plate, location timestamp, and volume lost.
  - Clicking event reveals point of occurrence on map.

---

### Suite 10: API Keys & Organization Profile (`/settings`)

#### TC-SETT-01: API Key Provisioning & Copying
- **Target URL:** `https://fleetvision.alvision.in/settings/api-key`
- **Priority:** P1 (Critical)
- **Steps:**
  1. Navigate to `/settings/api-key`.
  2. Click **"Generate New API Key"**.
  3. Verify key is generated (`fv_live_...`).
  4. Click **"Copy"** button.
  5. Test key against cURL:
     ```bash
     curl -H "x-api-key: <COPIED_KEY>" https://fleetvision.alvision.in/api/v1/vehicles
     ```
- **Expected Results:**
  - Key copies to clipboard with *"Copied!"* feedback.
  - Key successfully authenticates external REST API calls.

#### TC-SETT-02: API Key Revocation & Rotation
- **Priority:** P1 (Critical)
- **Steps:**
  1. Click **"Rotate Key"** or **"Revoke"**.
  2. Confirm action in modal.
  3. Re-run previous cURL command with revoked key.
- **Expected Results:**
  - Revoked key is invalidated immediately; cURL returns HTTP 401 Unauthorized.
  - New key is generated and displayed.

---

## 5. Backend Swagger API Test Suite (`/doc`)

Access the interactive Swagger UI at [https://fleetvision.alvision.in/doc](https://fleetvision.alvision.in/doc). Testers can authenticate using the **"Authorize"** button by providing a Bearer token or `x-api-key`.

### API Test Execution Matrix

| Tag | HTTP Method | Path | Test Purpose | Expected Status |
| :--- | :--- | :--- | :--- | :--- |
| **Auth** | `POST` | `/api/v1/auth/login` | Authenticate with email/password; set HttpOnly cookies | `200 OK` |
| **Auth** | `GET` | `/api/v1/auth/me` | Fetch currently authenticated user session | `200 OK` |
| **Auth** | `POST` | `/api/v1/auth/refresh` | Exchange refresh token for fresh access token | `200 OK` |
| **Auth** | `POST` | `/api/v1/auth/logout` | Revoke session and clear cookies | `200 OK` |
| **Orgs** | `POST` | `/api/v1/organizations` | Register new organization & admin | `201 Created` |
| **Orgs** | `GET` | `/api/v1/organizations/api-key` | Retrieve current organization API key | `200 OK` |
| **Orgs** | `POST` | `/api/v1/organizations/api-key` | Rotate/generate new API key | `200 OK` |
| **Orgs** | `GET` | `/api/v1/organizations/{id}` | Get organization details by ID | `200 OK` |
| **Vehicles** | `POST` | `/api/v1/vehicles` | Register vehicle with plate, VIN, make, model | `201 Created` |
| **Vehicles** | `GET` | `/api/v1/vehicles` | Query paginated vehicles list (`?page=1&limit=10`) | `200 OK` |
| **Vehicles** | `GET` | `/api/v1/vehicles/{vehicleId}` | Get single vehicle details | `200 OK` |
| **Vehicles** | `PUT` | `/api/v1/vehicles/{vehicleId}` | Update vehicle specs or speed limit | `200 OK` |
| **Vehicles** | `DELETE`| `/api/v1/vehicles/{vehicleId}` | Soft delete/de-register vehicle | `200 OK` |
| **Vehicles** | `POST` | `/api/v1/vehicles/{vehicleId}/fuel-calibration-table` | Set piecewise fuel calibration table | `200 OK` |
| **Vehicles** | `GET` | `/api/v1/vehicles/{vehicleId}/fuel-calibration-table` | Read piecewise fuel calibration table | `200 OK` |
| **Devices** | `POST` | `/api/v1/devices` | Register hardware tracker (15-digit IMEI) | `201 Created` |
| **Devices** | `GET` | `/api/v1/devices` | Query devices catalog | `200 OK` |
| **Devices** | `POST` | `/api/v1/devices/{deviceId}/assign` | Bind device to specific vehicle | `200 OK` |
| **Realtime** | `GET` | `/api/v1/track-vehicle?imei=...` | Query instantaneous position of single device | `200 OK` |
| **Realtime** | `GET` | `/api/v1/live-locations` | Snapshot of all active fleet coordinates | `200 OK` |
| **Realtime** | `GET` | `/api/v1/journey?imei=...&range=24h` | Historical route trail with downsampled coords | `200 OK` |
| **Reports** | `GET` | `/api/v1/reports/utilization` | Utilization report (distance, runtime, idle) | `200 OK` |
| **Reports** | `GET` | `/api/v1/reports/fuel-analytics` | Fuel consumption & drain event analytics | `200 OK` |
| **History** | `GET` | `/api/v1/history` | TimescaleDB raw telematics audit log | `200 OK` |
| **Geofence** | `POST` | `/api/v1/geofences` | Create Polygon or Circle geofence zone | `201 Created` |
| **Geofence** | `GET` | `/api/v1/geofences` | List organization geofences | `200 OK` |
| **Geofence** | `GET` | `/api/v1/geofences/{id}` | Read single geofence details | `200 OK` |
| **Geofence** | `PUT` | `/api/v1/geofences/{id}` | Update geofence boundaries or alert rules | `200 OK` |
| **Geofence** | `DELETE`| `/api/v1/geofences/{id}` | Remove geofence | `200 OK` |
| **Geofence** | `POST` | `/api/v1/geofences/{id}/test` | Test point-in-polygon coordinates | `200 OK` |
| **Alerts** | `GET` | `/api/v1/geofences/alerts` | Query historical geofence alert records | `200 OK` |
| **Alerts** | `GET` | `/api/v1/alerts` | Filter fleet alerts by category/date | `200 OK` |

---

## 6. Real-Time Streaming & Server-Sent Events (SSE) Validation

The platform utilizes persistent HTTP Server-Sent Events (`text/event-stream`).

### Streaming Endpoints to Test
1. **Fleet Status Stream:** `GET /api/v1/stream/fleet-status`
   - Emits aggregated counts of running, idle, stopped, inactive vehicles every few seconds.
2. **Device Telemetry Stream:** `GET /api/v1/stream/devices`
   - Emits real-time GPS coordinate arrays, speed, bearing, and device status.
3. **Fleet Map Stream:** `GET /api/v1/stream/fleet`
   - Broad telematics stream for map markers.
4. **Vehicle Journey Stream:** `GET /api/v1/stream/journey?imei=...`
   - Real-time breadcrumb tail appended to active moving trip.
5. **Alerts Stream:** `GET /api/v1/alerts/stream`
   - High-priority push stream for immediate geofence violations and overspeed alarms.

### QA SSE Test Checklist
- [ ] **Connection Headers:** Verify response header contains `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.
- [ ] **Heartbeat / Keep-Alive:** Verify backend sends comment or ping packets (e.g. `: ping\n\n`) every 15–30s to keep reverse proxies (Nginx/Cloudflare) from timing out.
- [ ] **Packet Format:** Verify incoming messages conform to standard SSE format:
  ```
  event: status
  data: {"running":5,"idle":2,"stopped":10,"inactive":1,"timestamp":"2026-10-23T12:00:00Z"}
  ```
- [ ] **Automatic Reconnection:** Kill the network for 5 seconds in Chrome DevTools; restore network. EventSource must automatically dispatch reconnect without throwing unhandled exceptions.
- [ ] **Memory Leak Check:** Keep the `/all-vehicles` live map open for 1 hour; monitor Chrome Task Manager to confirm JavaScript heap memory remains stable.

---

## 7. Security, Access Control & Multi-Tenancy Validation

#### SEC-01: Multi-Tenancy Data Isolation (Tenant Cross-Leakage)
- **Objective:** Ensure Organization A cannot see or mutate Organization B's assets.
- **Test Steps:**
  1. Register two separate test organizations: **Org A** and **Org B**.
  2. Create Vehicle A (`MH-01-A-1111`) and Geofence A in Org A.
  3. Log in as Org B admin.
  4. Attempt to query `GET /api/v1/vehicles/{Vehicle_A_ID}` or `DELETE /api/v1/geofences/{Geofence_A_ID}` using Org B's session or API key.
- **Expected Results:**
  - System returns `404 Not Found` or `403 Forbidden`. Under no circumstances should Org A's data be returned.

#### SEC-02: Cookie Security Attributes
- **Test Steps:**
  1. Inspect cookies in DevTools (Application -> Storage -> Cookies).
- **Expected Results:**
  - `access_token` and `refresh_token` must have:
    - `HttpOnly = true` (Inaccessible to `document.cookie` / XSS scripts)
    - `Secure = true` (Only transmitted over HTTPS)
    - `SameSite = Lax` or `Strict` (Protected against CSRF attacks)

#### SEC-03: Input Validation & Injection Resistance
- **Test Steps:**
  1. Enter SQL injection syntax (`' OR '1'='1`) into the Vehicle Plate Number, Search inputs, and Geofence Name.
  2. Enter XSS script payloads (`<script>alert(1)</script>`) into Organization Name or Vehicle Model.
- **Expected Results:**
  - Inputs are sanitized or rejected with validation errors.
  - Script payloads are rendered as harmless plain text strings; no code executes.

---

## 8. Cross-Browser, Responsive & Performance Testing

### 8.1 Device & Screen Resolution Matrix
| Device Type | Viewport Size | Primary Focus |
| :--- | :--- | :--- |
| **Mobile Phone** | `375 x 812` (iPhone X/13/15) | Hamburger menu, touch map gestures, card wrapping |
| **Mobile Phone** | `412 x 915` (Samsung Galaxy) | Bottom drawer navigation, table horizontal scrolling |
| **Tablet** | `768 x 1024` (iPad Portrait) | Split view layout, modal dialog sizing |
| **Laptop / Desktop** | `1366 x 768` (Standard Laptop) | Collapsible sidebar, map viewport fit |
| **High-Res Monitor** | `1920 x 1080` / `2560 x 1440` | Crisp typography, wide table layout, chart scaling |

### 8.2 Performance Benchmarks (Core Web Vitals)
- **Largest Contentful Paint (LCP):** `< 2.5 seconds` on 4G connection.
- **Interaction to Next Paint (INP):** `< 200 ms` for modal open, map clicks, and tab switching.
- **Cumulative Layout Shift (CLS):** `< 0.1` during dashboard widget load.
- **Live Tracking Stress Test:** Live map must render smoothly with 50+ simultaneous moving vehicle markers at 60 FPS without UI freezing.

---

## 9. Defect Reporting Guidelines & Bug Template

When logging an issue in Jira, GitHub Issues, or bug tracker, adhere to the following template:

```markdown
### [Bug Title]: Concise summary specifying module & issue (e.g., "[Live Map] Vehicle marker fails to update position on SSE payload")

**Environment:**
- **URL:** https://fleetvision.alvision.in/...
- **Browser & OS:** Chrome 130 on macOS / Windows 11
- **User Role / Org:** Admin / Test Org 1
- **Severity / Priority:** P1 - Critical

**Preconditions:**
- User is logged in and on `/all-vehicles`.
- Vehicle MH-12-QA-1001 is active.

**Steps to Reproduce:**
1. Navigate to `/all-vehicles`.
2. Select view mode "Map View".
3. Transmit a new GPS coordinate packet via TCP simulator.
4. Observe vehicle pin on map.

**Expected Result:**
Vehicle pin animates to the new coordinate latitude/longitude.

**Actual Result:**
Vehicle pin remains at previous coordinate; console outputs `TypeError: Cannot read properties of undefined (reading 'lat')`.

**Attachments / Network Logs:**
- [Attach Screenshot or Screen Recording Video]
- Network response payload or console stack trace:
  `...`
```

---

## 10. QA Sign-Off Checklist

Before certifying a release candidate for production deployment, all items below must be verified:

- [ ] **Authentication & Security:** Login, registration, token refresh, logout, and multi-tenant isolation 100% verified.
- [ ] **Live Telematics:** Real-time SSE streaming updates map markers and telemetry HUDs without lag or memory leaks.
- [ ] **Directory Management:** Vehicle and Hardware Device (IMEI) addition, validation, and assignment verified.
- [ ] **Fuel Calibration:** Piecewise linear calibration table correctly calculates tank volume in Liters.
- [ ] **Geofencing:** Polygon & Circle zone creation, map drawing, and breach alerts functional.
- [ ] **History & Playback:** Historical route trace, scrubber controls, and PDF audit generation tested.
- [ ] **Reports & Analytics:** Utilization and Fuel Analytics graphs and summaries calculate accurate values.
- [ ] **API Documentation:** All Swagger endpoints on `/doc` return documented status codes and schemas.
- [ ] **Cross-Platform:** Verified across Chrome, Firefox, Safari, and mobile browsers.
- [ ] **Zero P0 / P1 Defects:** No open Blocker or Critical defects remain unresolved.

---
*Fleet Vision Quality Assurance Team | Alvision Telematics*
