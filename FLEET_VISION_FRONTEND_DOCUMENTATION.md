# Fleet Vision Enterprise Frontend Documentation

> **Complete Technical Architecture, Client Applications, Real-Time Telematics Dashboards, Mapping Engines, and State Management Reference**  
> Workspace: `fleet-dashboard` (Standalone Portal) & `eximtransport/client` (Operational Console)  
> Frameworks: **Next.js 16 (App Router)** | **React 19** | **Tailwind CSS v4** | **Material UI** | **Leaflet** | **Mapbox GL**

---

## Table of Contents

1. [Executive Summary & System Architecture](#1-executive-summary--system-architecture)
2. [Dual Frontend Architecture Overview](#2-dual-frontend-architecture-overview)
3. [Technology Stack Matrix](#3-technology-stack-matrix)
4. [Standalone Admin Portal (`fleet-dashboard`)](#4-standalone-admin-portal-fleet-dashboard)
   - [Project Structure & File Organization](#project-structure--file-organization)
   - [Edge Proxy & Route Protection (`proxy.ts`)](#edge-proxy--route-protection-proxyts)
   - [Authentication & Session Lifecycle](#authentication--session-lifecycle)
   - [Organization Onboarding & Multi-Tenancy](#organization-onboarding--multi-tenancy)
   - [Hardware Device Management (`/devices`)](#hardware-device-management-devices)
   - [Vehicle Fleet Catalog (`/vehicles`)](#vehicle-fleet-catalog-vehicles)
   - [Piecewise Fuel Calibration Modal](#piecewise-fuel-calibration-modal)
   - [API Key Lifecycle & Provisioning](#api-key-lifecycle--provisioning)
   - [Real-Time Fleet Status HUD (`FleetStatusDashboard.tsx`)](#real-time-fleet-status-hud-fleetstatusdashboardtsx)
5. [Integrated Operational Console (`eximtransport/client`)](#5-integrated-operational-console-eximtransportclient)
   - [Component Hierarchy & Routing](#component-hierarchy--routing)
   - [Live Journey Telemetry Streamer (`LiveJourneyStream.jsx`)](#live-journey-telemetry-streamer-livejourneystreamjsx)
   - [Historical Track & Trip Playback Engine (`HistoricalTrack.jsx`)](#historical-track--trip-playback-engine-historicaltrackjsx)
   - [Automated Audit PDF Generator](#automated-audit-pdf-generator)
   - [Commercial Truck ETA Tracker (`ETATracker.jsx`)](#commercial-truck-eta-tracker-etatrackerjsx)
   - [Vehicle Dispatch Operations (`Vehicles.jsx`)](#vehicle-dispatch-operations-vehiclesjsx)
6. [Real-Time Streaming Protocols (SSE & Telematics)](#6-real-time-streaming-protocols-sse--telematics)
   - [SSE EventSource Lifecycle & Reconnection Strategy](#sse-eventsource-lifecycle--reconnection-strategy)
   - [Event Payloads & Schemas](#event-payloads--schemas)
7. [API Integration Layer & Network Contracts](#7-api-integration-layer--network-contracts)
8. [Design System, Theming & UI Tokens](#8-design-system-theming--ui-tokens)
   - [Light & Dark Color Palette](#light--dark-color-palette)
   - [Typography & Glassmorphic Styling](#typography--glassmorphic-styling)
   - [Responsive Layout Strategy](#responsive-layout-strategy)
9. [Development, Environment & Build Runbook](#9-development-environment--build-runbook)
10. [Enterprise Scalability Roadmap](#10-enterprise-scalability-roadmap)

---

## 1. Executive Summary & System Architecture

The **Fleet Vision Frontend Ecosystem** delivers an enterprise telematics and fleet management interface designed for transport operators, dispatchers, and hardware technicians. The frontend is divided into two specialized, complementary applications:

1. **Fleet Vision Client Portal (`fleet-dashboard`)**: A standalone, secure administrative control center built on **Next.js 16 (App Router)** and **React 19**. It oversees organization provisioning, hardware tracker inventory (IMEI registration), vehicle asset registration, fuel sensor piecewise calibration tables, and external REST API keys.
2. **Fleet Vision Operational Console (`eximtransport/client/src/components/fleet-vision`)**: A high-frequency operational dispatch suite embedded inside the enterprise transport logistics platform. It provides interactive map-based live GPS tracking, trip historical playback with scrubber controls, turn-by-turn route simplification, commercial truck ETA forecasting, and automated PDF compliance reports.

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   FLEET VISION FRONTEND ECOSYSTEM                               │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                  │
                 ┌────────────────────────────────┴────────────────────────────────┐
                 ▼                                                                 ▼
 ┌──────────────────────────────────────────────┐  ┌──────────────────────────────────────────────┐
 │       Fleet Vision Client Portal             │  │      Fleet Vision Operational Console        │
 │            (`fleet-dashboard`)               │  │       (`eximtransport/client`)               │
 ├──────────────────────────────────────────────┤  ├──────────────────────────────────────────────┤
 │ • Next.js 16 (App Router) + React 19         │  │ • React 18/19 SPA + React Router v6          │
 │ • Edge Proxy Route Protection (`proxy.ts`)   │  │ • Leaflet & Mapbox GL Map Visualization      │
 │ • HttpOnly Cookie BFF Session Authentication │  │ • Sub-second Live Journey Tracking (SSE)    │
 │ • Device IMEI Registration & Vehicle Binding │  │ • Historical Route Replay & Event Scrubber   │
 │ • Piecewise Fuel Calibration Table Editor    │  │ • Commercial Truck ETA Engine & Waypoints    │
 │ • API Key Provisioning & Organization Admin  │  │ • Instant Trip Audit PDF Report Generator    │
 │ • Real-Time Fleet Status Aggregation HUD     │  │ • Speedometer HUD, Tachometer & Gauges        │
 └──────────────────────┬───────────────────────┘  └──────────────────────┬───────────────────────┘
                        │                                                 │
                        │ REST Requests (`credentials: include`)          │ SSE Streams & REST Calls
                        │ Bearer API Tokens / HttpOnly Session            │ EventSource Connections
                        ▼                                                 ▼
 ┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
 │                                   FLEET VISION BACKEND SERVICES                                 │
 │                       Next.js API Gateway (:3000) & Redis Pub/Sub & TimescaleDB                 │
 └─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Dual Frontend Architecture Overview

| Dimension | `fleet-dashboard` (Standalone) | `eximtransport/client` (Operations) |
| :--- | :--- | :--- |
| **Primary User Persona** | Fleet Directors, Admins, Hardware Techs | Dispatchers, Fleet Controllers, Operations Managers |
| **Core Value** | Asset provisioning, sensor calibration, security | Real-time map navigation, telematics telemetry, audit |
| **Architecture** | Next.js 16 App Router (SSR + Client Components) | Single Page Application (Client-Side Rendered) |
| **Routing** | File-system App Router (`(auth)`, `(dashboard)`) | `react-router-dom` v6 Nested Routes |
| **Styling** | Tailwind CSS v4 + Native CSS Variables | Material UI (MUI v5) + SCSS Modules + Custom CSS |
| **Mapping Engine** | SVG Schematics & Metric HUDs | Leaflet (OSM tiles) + Mapbox GL JS (3D Vector maps) |
| **Real-time Pipeline**| SSE (`/api/v1/stream/fleet-status`) | SSE (`/api/v1/stream/journey`, `/api/v1/stream/fleet`)|
| **Auth Mode** | HttpOnly Cookie (BFF Pattern, Auto-Refresh) | Bearer Token / Embedded Session Context |

---

## 3. Technology Stack Matrix

```
[ Frameworks & Runtimes ]
  ├── Next.js 16.3.0 (App Router, Server Components & Edge Proxy)
  ├── React 19.2.8 (Hooks, Concurrent Mode, Context API)
  └── Node.js >= 20.x

[ Languages & Compilers ]
  ├── TypeScript 5.8 (Strict type safety, interfaces, union types)
  └── JavaScript (ES2024+, JSX)

[ Styling, Themes & Design Systems ]
  ├── Tailwind CSS v4.0 (CSS Variables engine, @theme inline tokens)
  ├── Material UI (MUI v5: Drawer, Buttons, Icons, Dialogs)
  ├── Lucide React & MUI Icons (Feather-derived SVG iconography)
  └── next-themes (Smooth Light/Dark theme switching without FOUC)

[ Mapping & Spatial Visualization ]
  ├── Leaflet 1.9.4 & React-Leaflet (Lightweight 2D maps, DivIcon rotations)
  ├── Mapbox GL JS 2.x (High-fidelity vector maps, 3D terrain, pitch)
  └── Douglas-Peucker Algorithm (Clientside polyline path simplification)

[ Data Visualization & Reporting ]
  ├── React-D3-Speedometer (Custom gauge dials for speed & tachometer)
  └── jsPDF + jsPDF-AutoTable (Client-side vector PDF generation)

[ Network & Protocols ]
  ├── Fetch API with Automatic 401 Interception & Refresh Mutex
  └── HTML5 Server-Sent Events (SSE) via native EventSource
```

---

## 4. Standalone Admin Portal (`fleet-dashboard`)

### Project Structure & File Organization

The application follows the modern Next.js 16 App Router architecture:

```text
fleet-dashboard/
├── app/
│   ├── (auth)/                                  # Public Route Group (No Sidebar Layout)
│   │   ├── login/
│   │   │   └── page.tsx                         # Glassmorphic Login Form & Credentials Validation
│   │   └── register-organization/
│   │       └── page.tsx                         # Organization & Tenant Self-Service Onboarding
│   ├── (dashboard)/                             # Protected Route Group (Nested under Sidebar Shell)
│   │   ├── layout.tsx                           # Master Shell with Desktop Sidebar & Mobile Bottom Nav
│   │   ├── page.tsx                             # Dashboard Landing: Fleet Status Stream & Metrics
│   │   ├── devices/
│   │   │   └── page.tsx                         # Device Inventory, IMEI Registration & Vehicle Pairing
│   │   ├── vehicles/
│   │   │   └── page.tsx                         # Vehicle Catalog, Plate/VIN Registration & Calibration
│   │   └── settings/
│   │       └── api-key/
│   │           └── page.tsx                     # API Key Management Wrapper
│   ├── globals.css                              # Design Tokens, Color Palettes, Glassmorphic Rules
│   └── layout.tsx                               # Root Layout: ThemeProvider & UserProvider Wrapper
├── components/
│   ├── ApiKeyManager.tsx                        # API Key Provisioning, Reveal/Hide & Copy UI
│   ├── ErrorModal.tsx                           # Reusable Accessible Alert/Error Dialog
│   ├── FleetStatusDashboard.tsx                 # Real-Time SSE Fleet Status Aggregation HUD
│   ├── FuelCalibrationModal.tsx                 # Piecewise Fuel Calibration Table Editor
│   ├── MetricCard.tsx                           # Minimalist Telemetry Metric Display Card
│   ├── RegisterOrganizationForm.tsx             # Organization Registration Form Component
│   ├── Sidebar.tsx                              # Adaptive Desktop Sidebar + Mobile Bottom Navigation
│   ├── SuccessModal.tsx                         # Confirmation Dialog
│   ├── ThemeProvider.tsx                        # next-themes Provider Wrapper
│   └── ThemeToggle.tsx                          # Light/Dark Theme Switcher Button
├── hooks/
│   └── useFleetStatusStream.ts                  # Resilient SSE Hook for /api/v1/stream/fleet-status
├── lib/
│   ├── api.ts                                   # fetchWithAuth, Silent Refresh Interceptor, Auth APIs
│   └── user-context.tsx                         # React Context Provider for Session & Org Metadata
├── types/
│   ├── auth.ts                                  # User, LoginCredentials, AuthError interfaces
│   ├── device.ts                                # Device, DeviceStatus interfaces
│   └── vehicle.ts                               # Vehicle, CalibrationPoint interfaces
├── utils/
│   └── colors.ts                                # Exported Design System Color Hex Tokens
├── proxy.ts                                     # Next.js 16 Edge Route Interception Proxy
└── next.config.ts                               # Next.js Configuration
```

---

### Edge Proxy & Route Protection (`proxy.ts`)

Next.js 16 supersedes standard middleware with the optimized `proxy.ts` pattern. The proxy executes at the edge, inspecting HTTP cookies before any rendering starts:

```typescript
// proxy.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const accessToken = request.cookies.get("accessToken");

  // Authenticated users navigating to /login are forwarded to dashboard
  if (pathname.startsWith("/login") && accessToken) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  // Public onboarding endpoints are bypassed
  if (pathname.startsWith("/login") || pathname.startsWith("/register-organization")) {
    return NextResponse.next();
  }

  // Protected routes require valid accessToken cookie; otherwise redirect to /login
  if (!accessToken) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
```

---

### Authentication & Session Lifecycle

The client employs a **Backend-For-Frontend (BFF)** pattern utilizing **HttpOnly Cookies**. Tokens are never stored in `localStorage` or `sessionStorage`, rendering the application immune to token theft via Cross-Site Scripting (XSS).

#### Token Refresh Interceptor (`lib/api.ts`)

Every HTTP call flows through `fetchWithAuth`:
1. Sends requests with `credentials: "include"` cross-origin.
2. If the backend returns `401 Unauthorized` (indicating the 15-minute access token expired), the client pauses the flow.
3. Automatically posts to `/api/v1/auth/refresh` using the persistent 7-day refresh token cookie.
4. On HTTP 200, the original failed request is re-executed transparently.
5. If the refresh token is invalid or expired, the user is redirected to `/login`.

```
[ Frontend Request ] ─── GET /api/v1/devices ───► [ Backend API ]
                                                         │
                                               401 Access Token Expired
                                                         │
                                                         ▼
[ Silent Refresh ]  ◄── POST /api/v1/auth/refresh ──────┘
         │
    HTTP 200 OK (New HttpOnly accessToken set)
         │
         ▼
[ Replay Request ]  ─── GET /api/v1/devices ───► [ Backend API ]
         │
    HTTP 200 OK (Data returned seamlessly to component)
```

#### Session State Provider (`lib/user-context.tsx`)

The `UserProvider` manages session hydration:
- On mount, if the user is not on a public path (`/login`, `/register-organization`), it executes `GET /api/v1/auth/me`.
- Populates `user: { id, email, organizationId, role }`.
- Exposes `setUser()` and `clearUser()`.
- Blocks rendering until session hydration completes, preventing visual flickers or unwanted redirects.

---

### Organization Onboarding & Multi-Tenancy

Located at `/register-organization`:
- Allows new enterprise tenants to register their corporate entity along with an initial administrator account.
- Dispatches `POST /api/v1/organizations` with `{ name, adminEmail, adminPassword }`.
- On success, automatically establishes session cookies and routes the user into the fleet dashboard.

---

### Hardware Device Management (`/devices`)

The Devices module manages hardware GPS trackers (primarily Teltonika FMx series):

```
┌────────────────────────────────────────────────────────────────────────┐
│                          DEVICE INVENTORY                              │
├──────────────────┬──────────────────────┬───────────────┬──────────────┤
│ IMEI NUMBER      │ STATUS               │ BOUND VEHICLE │ ACTIONS      │
├──────────────────┼──────────────────────┼───────────────┼──────────────┤
│ 864521049281723  │ ● ONLINE (Green)     │ MH-12-AB-1234 │ [Change Car] │
│ 869102948201948  │ ● PENDING (Amber)    │ Unassigned    │ [Assign Car] │
│ 861938204918204  │ ● OFFLINE (Red)      │ DL-01-XY-9876 │ [Change Car] │
└──────────────────┴──────────────────────┴───────────────┴──────────────┘
```

#### Key Capabilities:
- **Strict IMEI Validation**: Validates 15-digit numeric International Mobile Equipment Identity strings before submission.
- **Connection Status Indicators**:
  - `ONLINE`: Device actively sending AVL packets over TCP (last heartbeat < 300s).
  - `OFFLINE`: Device heartbeat exceeded timeout.
  - `PENDING_CONNECTION`: Registered in database, waiting for first TCP handshake packet.
- **Vehicle Binding Workflow**: Dispatches `POST /api/v1/devices/:deviceId/assign` with `{ vehicleId }` to associate or detach a tracker from a physical truck.

---

### Vehicle Fleet Catalog (`/vehicles`)

The Vehicles catalog provides fleet registry management:
- **Registration Modal**: Captures plate number, VIN, make, model, year, vehicle type, and fuel capacity.
- **Operational Status Flags**:
  - `ACTIVE`: Available for dispatch and continuous monitoring.
  - `INACTIVE`: Decommissioned or off-duty.
  - `MAINTENANCE`: In service bay; alerts suppressed.
- **Direct Fuel Calibration Access**: Each vehicle item contains a quick-access action menu opening the Fuel Calibration Modal.

---

### Piecewise Fuel Calibration Modal

Fuel sensors in commercial truck fuel tanks report raw analog or digital sensor values (e.g. 0 to 4095 or millivolts). Due to irregular tank geometries, raw sensor values do not map linearly to liters. 

The `FuelCalibrationModal.tsx` component provides a dynamic calibration table editor allowing technicians to enter sensor curves:

```
    Raw Sensor Reading (x)           Fuel Volume in Liters (y)
   ┌──────────────────────┐         ┌────────────────────────┐
   │ 0                    │ ──────► │ 0 L                    │
   │ 1024                 │ ──────► │ 65 L                   │
   │ 2048                 │ ──────► │ 180 L                  │
   │ 4095                 │ ──────► │ 400 L (Tank Max)       │
   └──────────────────────┘         └────────────────────────┘
```

#### Validation Engine:
1. **Minimum Points**: Requires at least 2 coordinate points to form a curve.
2. **Strict Monotonicity**: Liters must monotonically increase as raw values increase ($y_{i+1} > y_i$ for $x_{i+1} > x_i$).
3. **Capacity Ceiling**: Liters cannot exceed the vehicle's configured `maxFuelCapacity`.
4. **Duplicate Prevention**: Rejects duplicate raw sensor values ($x_i \ne x_j$).
5. **Non-Negative Bounds**: Raw values and liters must be $\ge 0$.

When saved, dispatches `PUT /api/v1/vehicles/:vehicleId/fuel-calibration-table`, invalidating the backend Redis cache (`calibration:<vehicleId>`) and propagating to the background Kafka processing pipeline immediately.

---

### API Key Lifecycle & Provisioning

Located at `/settings/api-key`:
- Provides external systems (ERPs, TMS, customs gateways) with programmatic access to Fleet Vision APIs.
- Features:
  - Masked rendering (`••••••••••••••••••••`) to prevent shoulder surfing.
  - Single-click reveal/hide toggle.
  - Clipboard copy with visual feedback badge.
  - Key rotation with warning confirmation to prevent breaking production integrations.

---

### Real-Time Fleet Status HUD (`FleetStatusDashboard.tsx`)

The dashboard features a live telemetry HUD driven by `useFleetStatusStream.ts`:

```
┌────────────────────────────────────────────────────────────────────────┐
│  FLEET OVERVIEW                                  ● Connected (SSE)     │
├──────────────┬──────────────┬──────────────┬─────────────┬─────────────┤
│ TOTAL: 48    │ RUNNING: 28  │ IDLE: 6      │ STOPPED: 12 │ NO DATA: 2  │
└──────────────┴──────────────┴──────────────┴─────────────┴─────────────┘
 [██████████████████████████████░░░░░░░░░░░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░░] 
  Running (58%)   Idle (12.5%)   Stopped (25%)   No Data (4.5%)
```

- **Metrics Cards**: Instant counter for `TOTAL`, `RUNNING`, `IDLE`, `STOPPED`, `INACTIVE`, and `NO_DATA`.
- **Distribution Progress Bar**: Visual proportional breakdown bar with dynamic theme colors.
- **Live Activity Feed**: Captures incoming status changes (e.g. `IMEI 86452... changed from IDLE to RUNNING`) in real time.

---

## 5. Integrated Operational Console (`eximtransport/client`)

### Component Hierarchy & Routing

Embedded within EximTransport under `/fleet-vision/*`:

```text
eximtransport/client/src/components/fleet-vision/
├── FleetVision.jsx                              # Shell layout with route switches
├── FleetVisionSidebar.jsx                       # MUI Drawer with active route highlighting
├── FleetStatusDashboard.jsx                     # High-level operational overview & status charts
├── LiveJourneyStream.jsx                        # Real-time SSE map tracking & vehicle HUD
├── HistoricalTrack.jsx                          # Route replay, timeline scrubber & PDF export
├── ETATracker.jsx                               # Mapbox GL commercial truck navigation & ETA
├── Vehicles.jsx                                 # Fleet vehicle table with status badges
├── TruckDashboard/                              # Single-vehicle telemetry drilldown
├── components/
│   └── BackButton.jsx                           # Standard navigation back button
└── utils/
    ├── colors.js                                # Theme color constants (FLEET_COLORS)
    ├── time.js                                  # UTC / Local timezone formatting utilities
    └── generateHistoricalTrackPdf.js            # Automated trip audit PDF generator
```

---

### Live Journey Telemetry Streamer (`LiveJourneyStream.jsx`)

The Live Journey module provides continuous vehicle position tracking on an interactive Leaflet map:

```
┌────────────────────────────────────────────────────────────────────────┐
│ [◄ Back]  Live Journey: MH-12-AB-1234              ● Live Connected    │
├────────────────────────────────────────┬───────────────────────────────┤
│                                        │ TELEMETRY HUD                 │
│                                        ├───────────────────────────────┤
│             ▲                          │ SPEEDOMETER                   │
│             │  (Truck icon rotated     │     ╭───────╮                 │
│          ┌─────┐ by heading angle)     │    │  64 km/h│                 │
│          │  🚚 │                       │     ╰───────╯                 │
│          └─────┘                       ├───────────────────────────────┤
│          /                             │ IGNITION:   [ ON  (Green) ]   │
│         /   (Breadcrumb trail)         │ SPEED:      64 km/h           │
│        /                               │ LATITUDE:   18.5204° N        │
│       ● Start Pin                      │ LONGITUDE:  73.8567° E        │
│                                        │ UPDATED:    2s ago            │
└────────────────────────────────────────┴───────────────────────────────┘
```

#### Key Technical Capabilities:
1. **Dynamic Heading Rotation**: The truck marker's SVG icon rotates in real time using CSS `transform: rotate(${angle}deg)` with linear transition interpolation for smooth directional changes.
2. **Auto-Follow Camera**: When enabled, the map automatically shifts its center and fits bounds (`map.panTo` / `map.fitBounds`) as new coordinates arrive.
3. **Breadcrumb Polyline**: Appends incoming coordinates to a live Leaflet `<Polyline />` rendered in the brand accent color (`#1D6F64`).
4. **React-D3-Speedometer**: Renders an analog needle speedometer showing current speed against custom safety thresholds.

---

### Historical Track & Trip Playback Engine (`HistoricalTrack.jsx`)

The Historical Track engine allows dispatchers to replay past journeys with precision:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Time Range: [ 2026-09-17 08:00 ] to [ 2026-09-17 18:00 ]   [ Query ]   │
├────────────────────────────────────────────────────────────────────────┤
│ MAP VIEW (Leaflet + Douglas-Peucker Simplified Trajectory)            │
│  [Start Pin] ───(Green: Moving)─── [Stop Event] ───(Red: Stop)─── [End] │
├────────────────────────────────────────────────────────────────────────┤
│ PLAYBACK CONTROLS:                                                     │
│  [ ▶ Play ]  [ ❚❚ Pause ]  [ ⏹ Reset ]   Speed: [ 1x | 5x | 10x | 50x ] │
│  00:00 ───●──────────────────────────────────────────────────── 10:00 │
├────────────────────────────────────────────────────────────────────────┤
│ TRIP SUMMARY:                                                          │
│  Distance: 342.5 km | Max Speed: 78 km/h | Idle Time: 42m | [Export PDF]│
└────────────────────────────────────────────────────────────────────────┘
```

#### Trajectory Processing:
- Fetches raw historical records from `GET /api/v1/history?imei=...&startTime=...&endTime=...`.
- Points are simplified on the backend using the **Douglas-Peucker Algorithm** with customizable epsilon tolerances to prevent browser memory overload.
- Points are categorized into operational states:
  - **Running** (Speed > 2 km/h): Green marker / segment.
  - **Idle** (Speed $\le$ 2 km/h with Ignition ON): Yellow marker / segment.
  - **Stopped** (Ignition OFF): Red marker / segment.

---

### Automated Audit PDF Generator

Located in `utils/generateHistoricalTrackPdf.js`:
- Uses **jsPDF** and **jsPDF-AutoTable** to compile official transport compliance reports directly in the browser.
- **Included Report Data**:
  - Corporate header and branding.
  - Vehicle plate number, device IMEI, and selected time window.
  - Total distance traveled (km), total running duration, idle time, and stationary time.
  - Maximum recorded speed and average moving speed.
  - Chronological table of significant events: ignition toggles, geofence entries/exits, and prolonged stops (> 15 mins).
- Downloads instantly without placing rendering load on backend servers.

---

### Commercial Truck ETA Tracker (`ETATracker.jsx`)

The ETA Tracker leverages **Mapbox GL JS** for high-precision commercial vehicle navigation:

```
┌────────────────────────────────────────────────────────────────────────┐
│  Select Truck: [ MH-12-AB-1234 ]   Destination: [ Mumbai Port, Gate 2 ]│
├────────────────────────────────────────────────────────────────────────┤
│ MAPBOX 3D VECTOR MAP                                                   │
│    Current Position ─── Blue Highway Route Line ───► Destination Flag  │
│                                                                        │
│   TRUCK ETA HUD:                                                       │
│   ┌──────────────────────┬──────────────────────┬──────────────────┐   │
│   │ ESTIMATED ARRIVAL    │ DISTANCE REMAINING   │ BEARING / COURSE │   │
│   │ 3 hrs 24 mins        │ 164.2 km             │ 312° NW          │   │
│   └──────────────────────┴──────────────────────┴──────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

#### Technical Implementations:
1. **Bearing Calculation**: Computes real-time angular heading between successive GPS coordinates using spherical trigonometry:
   $$\theta = \text{atan2}(\sin(\Delta \lambda)\cos(\phi_2), \; \cos(\phi_1)\sin(\phi_2) - \sin(\phi_1)\cos(\phi_2)\cos(\Delta \lambda))$$
2. **Commercial Truck Speed Adjustment**: Adjusts standard consumer car routing profiles with heavy-vehicle speed caps and commercial break intervals.
3. **Destination Geocoding Autocomplete**: Debounced search input querying Mapbox Geocoding APIs.

---

### Vehicle Dispatch Operations (`Vehicles.jsx`)

A unified operational table for transport coordinators:
- Search and filter vehicles by plate, driver, or operational status.
- One-click navigation shortcuts to **Live Journey**, **Historical Track**, or **ETA Tracker** pre-seeded with the vehicle's IMEI.
- Displays device battery voltage, cellular signal strength, and last-seen timestamps.

---

## 6. Real-Time Streaming Protocols (SSE & Telematics)

Fleet Vision uses **Server-Sent Events (HTML5 SSE)** over traditional WebSockets for real-time telemetry streaming:

### Why Server-Sent Events?
1. **Unidirectional Simplicity**: Telematics telemetry flows from truck to server to browser. Bidirectional WebSocket overhead is unnecessary.
2. **Native HTTP/2 Multiplexing**: Multiple SSE streams share a single TCP connection.
3. **Automatic Reconnection**: Browsers automatically handle disconnections with built-in reconnect headers.
4. **Corporate Firewall Friendly**: Transports over standard HTTPS port 443 with standard HTTP request headers.

### SSE EventSource Lifecycle & Reconnection Strategy

```
  Component Mount
        │
        ▼
  new EventSource("/api/v1/stream/...")
        │
        ├──► onopen ──────► Set Status: "connected"
        │
        ├──► onmessage ───► Parse JSON ──► Update React State
        │
        └──► onerror ─────► Set Status: "error" / "reconnecting"
                                  │
                                  ▼
                            Wait 5000ms
                                  │
                                  ▼
                            Auto Reconnect
```

#### Implementation in `hooks/useFleetStatusStream.ts`:
```typescript
const source = new EventSource(`${API_BASE}/api/v1/stream/fleet-status`, {
  withCredentials: true,
});

source.addEventListener("init", (event) => {
  const data = JSON.parse(event.data);
  setCounts(data.counts);
  setLastUpdated(new Date(data.computedAt));
});

source.addEventListener("update", (event) => {
  const data = JSON.parse(event.data);
  if (data.counts) setCounts(data.counts);
  if (data.changed) {
    setRecentChanges(prev => [...data.changed, ...prev].slice(0, 5));
  }
});

source.onerror = () => {
  setConnectionStatus("reconnecting");
  source.close();
  setTimeout(() => connectImpl(), 5000);
};
```

### Event Payloads & Schemas

#### 1. Fleet Status Stream (`/api/v1/stream/fleet-status`)

- **`init` event**:
```json
{
  "counts": {
    "TOTAL": 45,
    "RUNNING": 22,
    "IDLE": 8,
    "STOPPED": 12,
    "INACTIVE": 2,
    "NO_DATA": 1
  },
  "computedAt": "2026-09-18T12:00:00.000Z"
}
```

- **`update` event**:
```json
{
  "counts": { "TOTAL": 45, "RUNNING": 23, "IDLE": 7, "STOPPED": 12, "INACTIVE": 2, "NO_DATA": 1 },
  "changed": [
    { "imei": "864521049281723", "previousStatus": "IDLE", "newStatus": "RUNNING" }
  ],
  "timestamp": "2026-09-18T12:00:15.000Z"
}
```

#### 2. Live Journey Stream (`/api/v1/stream/journey?imei=...`)

```json
{
  "imei": "864521049281723",
  "latitude": 18.52043,
  "longitude": 73.85674,
  "speed": 62,
  "angle": 145,
  "altitude": 560,
  "ignition": true,
  "fuelLiters": 284.5,
  "timestamp": "2026-09-18T12:00:16.000Z"
}
```

---

## 7. API Integration Layer & Network Contracts

| Endpoint | Method | Purpose | Auth Required |
| :--- | :--- | :--- | :--- |
| `/api/v1/auth/login` | POST | Authenticate user & issue HttpOnly cookies | No |
| `/api/v1/auth/refresh` | POST | Refresh expired access token cookie | Cookie |
| `/api/v1/auth/me` | GET | Retrieve authenticated user profile | Cookie / Bearer |
| `/api/v1/auth/logout` | POST | Invalidate session & clear cookies | Cookie |
| `/api/v1/organizations` | POST | Register new tenant organization | No |
| `/api/v1/organizations/api-key` | GET/POST | View or generate external API key | Cookie (Admin) |
| `/api/v1/devices` | GET/POST | List registered devices or add new IMEI | Cookie / Bearer |
| `/api/v1/devices/:id/assign` | POST | Bind or unbind device to a vehicle | Cookie / Bearer |
| `/api/v1/vehicles` | GET/POST | List vehicles or register new vehicle | Cookie / Bearer |
| `/api/v1/vehicles/:id/fuel-calibration-table` | GET/PUT | Read or save piecewise fuel calibration table | Cookie / Bearer |
| `/api/v1/stream/fleet-status` | GET (SSE) | Live aggregate fleet status stream | Cookie / Bearer |
| `/api/v1/stream/journey` | GET (SSE) | Live single-vehicle telemetry stream | Cookie / Bearer |
| `/api/v1/stream/fleet` | GET (SSE) | Live fleet-wide GPS stream | Cookie / Bearer |
| `/api/v1/history` | GET | Query Douglas-Peucker simplified history | Cookie / Bearer |

---

## 8. Design System, Theming & UI Tokens

### Light & Dark Color Palette

Fleet Vision uses a curated, accessible color palette defined in `globals.css` and `utils/colors.ts`:

```
┌────────────────────┬──────────────┬──────────────┬───────────────────────────────┐
│ TOKEN              │ LIGHT MODE   │ DARK MODE    │ USAGE                         │
├────────────────────┼──────────────┼──────────────┼───────────────────────────────┤
│ `--background`     │ `#F7F6F2`    │ `#12151A`    │ Application canvas background │
│ `--surface`        │ `#FFFFFF`    │ `#181C22`    │ Cards, modals, sidebars       │
│ `--surface-sunken` │ `#F0F1EE`    │ `#0F1216`    │ Inset panels, hero banners    │
│ `--ink`            │ `#14181D`    │ `#EDEEEC`    │ Primary text & headings       │
│ `--text-secondary` │ `#626B76`    │ `#89939F`    │ Subtitles, labels, captions   │
│ `--hairline`       │ `#E3E1DA`    │ `#2A303A`    │ Card borders, divider lines   │
│ `--accent`         │ `#1D6F64`    │ `#4FBBA6`    │ Brand primary, active links   │
│ `--accent-tint`    │ `#E4EEEC`    │ `rgba(...)`  │ Active button/badge fills     │
│ `--status-warning` │ `#B8860B`    │ `#D4A33B`    │ Idle status, reconnecting     │
│ `--status-critical`│ `#C0392B`    │ `#E74C3C`    │ Stopped status, error alerts  │
└────────────────────┴──────────────┴──────────────┴───────────────────────────────┘
```

### Typography & Glassmorphic Styling

- **Headings**: `Space Grotesk`, sans-serif (clean, geometric, tech-forward).
- **Body & Controls**: `Work Sans`, sans-serif (high legibility at small sizes).
- **Telemetry & Numbers**: `IBM Plex Mono`, monospace (used for IMEIs, coordinates, VINs, and speed dials).

#### Glassmorphism Utilities (`globals.css`):
```css
.glass-card {
  background: var(--surface);
  border: 1px solid var(--hairline);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.05);
}
```

### Responsive Layout Strategy

1. **Desktop ($> 768\text{px}$)**:
   - Fixed, collapsible left sidebar (`w-56`).
   - Content area flexes with full width and auto vertical scroll.
2. **Mobile ($\le 768\text{px}$)**:
   - Left sidebar unmounts.
   - Fixed bottom navigation bar (`h-16`) with tap targets for Dashboard, Devices, Vehicles, and Settings.
   - Modals convert to full-screen drawers for touch ergonomics.

---

## 9. Development, Environment & Build Runbook

### Environment Configuration (`.env.local`)

```bash
# Backend Gateway URL
NEXT_PUBLIC_API_URL="http://localhost:3000"

# Mapbox Access Token for Vector Map & Navigation (EximTransport Console)
REACT_APP_MAPBOX_ACCESS_TOKEN="pk.eyJ1IjoieWFzaCIsImEiOiJjb..."

# Port configuration
PORT=8080
```

### Development Commands

```bash
# 1. Install dependencies
npm install

# 2. Run standalone client in development mode on port 8080
npm run dev

# 3. Execute linting & static analysis
npm run lint

# 4. Production build validation
npm run build

# 5. Start production server
npm run start
```

---

## 10. Enterprise Scalability Roadmap

As the fleet scales to hundreds of thousands of active connected vehicles, the following architectural upgrades are scheduled:

1. **Client State Engine (Zustand)**:
   - Replace standard React Context with **Zustand** stores with selector subscriptions to prevent cascading re-renders across the dashboard during high-frequency telemetry updates.
2. **TanStack Query (React Query)**:
   - Adopt React Query for device and vehicle catalog caching, automatic background revalidation, and optimistic updates.
3. **Promise Mutex Refresh Queue**:
   - Implement an in-memory queue inside `fetchWithAuth`. If 10 concurrent requests trigger a 401 simultaneously, only a single `/refresh` call is dispatched while the other 9 await the resolved promise.
4. **Web Workers for Geometric Simplification**:
   - Offload clientside Douglas-Peucker point filtering and bearing calculations to a background Web Worker, keeping the main UI thread at 60 FPS during intensive 10,000-point trip playback.
5. **Bidirectional WebTransport / WebSockets**:
   - Introduce secure bidirectional channels for vehicle immobilization commands, remote parameter reconfiguration, and over-the-air (OTA) firmware triggers.

---

*Fleet Vision Frontend Architecture Documentation — Maintained by the Fleet Vision Engineering Team.*
