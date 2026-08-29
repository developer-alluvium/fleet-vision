import { NextResponse } from "next/server";

export async function GET() {
  const openApiSpec = {
    openapi: "3.0.0",
    info: {
      title: "Fleet Vision API Documentation",
      version: "1.0.0",
      description:
        "Comprehensive API reference and interactive testing console for the Fleet Vision Enterprise Telemetry & Fleet Management Platform.\n\n" +
        "### Authentication\n" +
        "The API supports authentication via:\n" +
        "1. **Bearer Token (JWT)**: Include header `Authorization: Bearer <your_jwt_token>`.\n" +
        "2. **Organization API Key**: Include header `x-api-key: <your_api_key>`.\n" +
        "3. **HttpOnly Cookie**: Automatically sent by modern browsers after logging in via `/api/v1/auth/login`.\n\n" +
        "### Multi-Tenancy & Authorization\n" +
        "Requests are strictly scoped by Organization ID. Most endpoints will automatically derive the `orgId` from the caller's authentication context if omitted.",
    },
    servers: [
      {
        url: "http://localhost:3000",
        description: "Local Development Server (Localhost)",
      },
      {
        url: "http://192.168.0.160:3000",
        description: "Local Network Server",
      },
    ],
    tags: [
      {
        name: "Authentication",
        description: "Endpoints for user session management, login, logout, and token refresh.",
      },
      {
        name: "Organizations",
        description: "Endpoints for managing organizations, initial admin accounts, and API key generation.",
      },
      {
        name: "Vehicles",
        description: "Endpoints for vehicle registration, fleet listings, and BLE sensor calibrations.",
      },
      {
        name: "Devices",
        description: "Endpoints for registering telemetry hardware (IMEI), hardware listing, and vehicle assignment.",
      },
      {
        name: "Real-Time & Telemetry",
        description: "Endpoints for live vehicle positioning, Server-Sent Events (SSE) streaming, and journey trails.",
      },
      {
        name: "Analytics & History",
        description: "Endpoints for fetching historical TimescaleDB telemetry logs, trip summaries, and distance metrics.",
      },
    ],
    paths: {
      // ─────────────────────────────────────────────────────────
      // AUTHENTICATION
      // ─────────────────────────────────────────────────────────
      "/api/v1/auth/login": {
        post: {
          tags: ["Authentication"],
          summary: "Organization User Login",
          description:
            "Authenticates a user using email and password. Upon successful authentication, issues secure `access_token` and `refresh_token` HttpOnly cookies and returns the authenticated user object.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LoginRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Successful login. HttpOnly cookies set.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/LoginResponse" },
                },
              },
            },
            "400": {
              description: "Bad Request - Missing email or password.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "401": {
              description: "Unauthorized - Invalid email or password.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Internal server error.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/api/v1/auth/me": {
        get: {
          tags: ["Authentication"],
          summary: "Get Current Authenticated User",
          description:
            "Returns details of the currently logged-in user. If the access token cookie is expired, automatically attempts to issue new access tokens using the refresh token.",
          security: [{ cookieAuth: [] }, { bearerAuth: [] }],
          responses: {
            "200": {
              description: "User details retrieved successfully.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      user: { $ref: "#/components/schemas/User" },
                    },
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized - Invalid, expired, or missing session token.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Internal server error.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/api/v1/auth/refresh": {
        post: {
          tags: ["Authentication"],
          summary: "Refresh Access Token",
          description:
            "Exchanges a valid HttpOnly refresh token cookie for a brand new access token and refresh token.",
          security: [{ cookieAuth: [] }],
          responses: {
            "200": {
              description: "Token refreshed successfully.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      message: { type: "string", example: "Token refreshed" },
                    },
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized - Invalid or missing refresh token.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Internal server error.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/api/v1/auth/logout": {
        post: {
          tags: ["Authentication"],
          summary: "User Logout",
          description:
            "Logs out the user by revoking the refresh token in Redis/Database and clearing authentication HttpOnly cookies.",
          security: [{ cookieAuth: [] }, { bearerAuth: [] }],
          responses: {
            "200": {
              description: "Successfully logged out.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      message: { type: "string", example: "Logged out successfully" },
                    },
                  },
                },
              },
            },
            "500": {
              description: "Internal server error.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },

      // ─────────────────────────────────────────────────────────
      // ORGANIZATIONS
      // ─────────────────────────────────────────────────────────
      "/api/v1/organizations": {
        post: {
          tags: ["Organizations"],
          summary: "Create Organization & Admin Account",
          description:
            "Creates a new Organization record and its initial Admin User account in an atomic database transaction.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/RegisterOrgRequest" },
              },
            },
          },
          responses: {
            "201": {
              description: "Organization and Admin User created successfully.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/RegisterOrgResponse" },
                },
              },
            },
            "400": {
              description: "Validation error - Invalid email, missing name, or password length < 6.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "409": {
              description: "Conflict - A user with this email already exists.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Internal server error.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
        get: {
          tags: ["Organizations"],
          summary: "List All Organizations",
          description:
            "Retrieves a list of all registered organizations along with counts of associated users, devices, and vehicles.",
          responses: {
            "200": {
              description: "List of organizations retrieved.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      organizations: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Organization" },
                      },
                    },
                  },
                },
              },
            },
            "500": {
              description: "Internal server error.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/api/v1/organizations/api-key": {
        post: {
          tags: ["Organizations"],
          summary: "Generate Organization API Key",
          description:
            "Generates a new secure 64-character hex API key (`fv_live_...`) for the caller's organization. Requires a valid JWT user login session.",
          security: [{ bearerAuth: [] }, { cookieAuth: [] }],
          responses: {
            "201": {
              description: "New API Key generated successfully.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ApiKeyResponse" },
                },
              },
            },
            "401": {
              description: "Unauthorized - Missing JWT token.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "403": {
              description: "Forbidden - Must be logged in as a user (API key auth cannot generate API keys).",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Internal server error.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
        get: {
          tags: ["Organizations"],
          summary: "Get Stored API Key",
          description:
            "Fetches the existing API key for the caller's organization. Requires a valid JWT user login session.",
          security: [{ bearerAuth: [] }, { cookieAuth: [] }],
          responses: {
            "200": {
              description: "API key retrieved.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ApiKeyResponse" },
                },
              },
            },
            "401": {
              description: "Unauthorized - Missing JWT token.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "403": {
              description: "Forbidden - Must be logged in as a user.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Internal server error.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },

      // ─────────────────────────────────────────────────────────
      // VEHICLES
      // ─────────────────────────────────────────────────────────
      "/api/v1/vehicles": {
        post: {
          tags: ["Vehicles"],
          summary: "Register New Vehicle",
          description:
            "Registers a new fleet vehicle in the database. Verifies uniqueness of plate number and VIN.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }, { cookieAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/RegisterVehicleRequest" },
              },
            },
          },
          responses: {
            "201": {
              description: "Vehicle registered successfully.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      vehicle: { $ref: "#/components/schemas/Vehicle" },
                    },
                  },
                },
              },
            },
            "400": {
              description: "Bad Request - Missing required parameters or invalid JSON payload.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "401": {
              description: "Unauthorized - Authentication required.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "403": {
              description: "Forbidden - Attempted to create vehicle in unauthorized organization.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "404": {
              description: "Not Found - Specified organization does not exist.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "409": {
              description: "Conflict - A vehicle with this plate number or VIN already exists.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Internal server error.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
        get: {
          tags: ["Vehicles"],
          summary: "List Organization Vehicles",
          description:
            "Lists all registered vehicles for an organization, including currently assigned hardware devices.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }, { cookieAuth: [] }],
          parameters: [
            {
              name: "orgId",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Optional Organization ID (derived automatically from auth token if omitted).",
            },
          ],
          responses: {
            "200": {
              description: "Vehicles retrieved successfully.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      vehicles: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Vehicle" },
                      },
                    },
                  },
                },
              },
            },
            "400": {
              description: "Missing orgId parameter when auth context has no organization.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "401": {
              description: "Unauthorized.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "403": {
              description: "Forbidden.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Internal server error.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/api/v1/vehicles/{vehicleId}/fuel-calibration": {
        get: {
          tags: ["Vehicles"],
          summary: "Get Vehicle BLE Fuel Calibration",
          description:
            "Retrieves the active Bluetooth Low Energy (BLE) fuel sensor channel setting for a specific vehicle.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }, { cookieAuth: [] }],
          parameters: [
            {
              name: "vehicleId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Vehicle CUID",
            },
          ],
          responses: {
            "200": {
              description: "Fuel calibration setting retrieved.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/FuelCalibration" },
                },
              },
            },
            "401": {
              description: "Unauthorized.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "403": {
              description: "Forbidden - Accessing vehicle from another organization.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "404": {
              description: "Not Found - Vehicle does not exist.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Internal server error.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
        put: {
          tags: ["Vehicles"],
          summary: "Update Vehicle BLE Fuel Calibration",
          description:
            "Updates the BLE fuel channel assignment for a vehicle and automatically invalidates Redis settings cache so the ingestion worker instantly picks up the change.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }, { cookieAuth: [] }],
          parameters: [
            {
              name: "vehicleId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Vehicle CUID",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UpdateFuelCalibrationRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Fuel calibration updated successfully.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      vehicle: { $ref: "#/components/schemas/Vehicle" },
                    },
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "403": {
              description: "Forbidden.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "404": {
              description: "Vehicle not found.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Internal server error.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },

      // ─────────────────────────────────────────────────────────
      // DEVICES
      // ─────────────────────────────────────────────────────────
      "/api/v1/devices": {
        post: {
          tags: ["Devices"],
          summary: "Register Telemetry Device",
          description:
            "Registers a new hardware GPS device by 15-digit IMEI and synchronizes device credentials to Redis cache for low-latency TCP socket authentication.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }, { cookieAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/RegisterDeviceRequest" },
              },
            },
          },
          responses: {
            "201": {
              description: "Device registered and cached successfully.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      device: { $ref: "#/components/schemas/Device" },
                    },
                  },
                },
              },
            },
            "400": {
              description: "Invalid IMEI or missing required fields.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "401": {
              description: "Unauthorized.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "403": {
              description: "Forbidden.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "404": {
              description: "Organization not found.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "409": {
              description: "Device IMEI already registered.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Internal server error.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
        get: {
          tags: ["Devices"],
          summary: "List Registered Devices",
          description:
            "Retrieves all GPS tracking devices registered under an organization.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }, { cookieAuth: [] }],
          parameters: [
            {
              name: "orgId",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Optional Organization ID (derived automatically from auth token if omitted).",
            },
          ],
          responses: {
            "200": {
              description: "Devices list retrieved successfully.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      devices: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Device" },
                      },
                    },
                  },
                },
              },
            },
            "400": {
              description: "Missing orgId parameter when auth context is absent.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "401": {
              description: "Unauthorized.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Internal server error.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/api/v1/devices/{deviceId}/assign": {
        post: {
          tags: ["Devices"],
          summary: "Assign/Unassign Vehicle to Device",
          description:
            "Links a registered vehicle to a hardware telemetry device, or unlinks it when `vehicleId` is `null`.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }, { cookieAuth: [] }],
          parameters: [
            {
              name: "deviceId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Device CUID",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AssignDeviceRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Device updated successfully.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      device: { $ref: "#/components/schemas/Device" },
                    },
                  },
                },
              },
            },
            "400": {
              description: "Bad Request - Vehicle belongs to a different organization.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "401": {
              description: "Unauthorized.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "403": {
              description: "Forbidden.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "404": {
              description: "Device or Vehicle not found.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "409": {
              description: "Vehicle is already assigned to another device.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Internal server error.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },

      // ─────────────────────────────────────────────────────────
      // REAL-TIME & TELEMETRY
      // ─────────────────────────────────────────────────────────
      "/api/v1/track-vehicle": {
        post: {
          tags: ["Real-Time & Telemetry"],
          summary: "Batch Track Current Locations",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }, { apiKeyAuthQuery: [] }, { cookieAuth: [] }],
          description: "Retrieves real-time GPS locations and telemetry data for a provided list of vehicle IMEIs. This endpoint is optimized for batch tracking, allowing you to pass up to 50 IMEIs in a single request to monitor fleet movements continuously.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TrackVehicleRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Array of tracking results.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/TrackVehicleResponse" },
                },
              },
            },
            "400": {
              description: "Bad Request. Invalid IMEI format or array limit exceeded.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "401": {
              description: "Unauthorized. Missing or invalid authentication.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "403": {
              description: "Forbidden. One or more IMEIs do not belong to the organization.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Internal server error.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },

      "/api/v1/live-locations": {
        get: {
          tags: ["Real-Time & Telemetry"],
          summary: "Get Current Live Fleet Locations",
          description:
            "Queries Redis memory cache to return latest GPS positioning coordinates, ignition status, speed, and fuel levels for all devices in an organization.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }, { cookieAuth: [] }],
          parameters: [
            {
              name: "orgId",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Optional Organization ID (derived from authentication context if omitted).",
            },
          ],
          responses: {
            "200": {
              description: "Live locations returned successfully.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      locations: {
                        type: "array",
                        items: { $ref: "#/components/schemas/LiveLocation" },
                      },
                    },
                  },
                },
              },
            },
            "400": {
              description: "Missing orgId parameter when auth context is absent.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "401": {
              description: "Unauthorized.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Internal server error.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/api/v1/stream/fleet": {
        get: {
          tags: ["Real-Time & Telemetry"],
          summary: "Stream Live Fleet Locations (SSE)",
          description:
            "Establishes a persistent Server-Sent Events (SSE) connection that streams real-time vehicle location updates across the organization.\n\n" +
            "**Events emitted:**\n" +
            "- `init`: Initial payload containing all devices and latest positions upon connection.\n" +
            "- `location:update`: Pushed instantly when a vehicle submits new telemetry.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }, { cookieAuth: [] }],
          responses: {
            "200": {
              description: "SSE connection established (Content-Type: text/event-stream).",
            },
            "401": {
              description: "Unauthorized.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "403": {
              description: "Forbidden.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Internal server error.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/api/v1/journey": {
        get: {
          tags: ["Real-Time & Telemetry"],
          summary: "Get Journey Path Coordinates",
          description:
            "Fetches ordered GPS path coordinates for a specific device IMEI.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }, { cookieAuth: [] }],
          parameters: [
            {
              name: "imei",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "15-digit Device IMEI number",
            },
            {
              name: "orgId",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Optional Organization ID (derived automatically if omitted).",
            },
            {
              name: "since",
              in: "query",
              required: false,
              schema: { type: "string", format: "date-time" },
              description: "ISO 8601 start timestamp filter. Defaults to 1 hour ago.",
            },
          ],
          responses: {
            "200": {
              description: "Journey trail retrieved.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      imei: { type: "string", example: "353456789012345" },
                      points: {
                        type: "array",
                        items: { $ref: "#/components/schemas/TelemetryPoint" },
                      },
                    },
                  },
                },
              },
            },
            "400": {
              description: "Invalid or missing imei parameter.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "401": {
              description: "Unauthorized.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Internal server error.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/api/v1/stream/journey": {
        get: {
          tags: ["Real-Time & Telemetry"],
          summary: "Stream Live Single-Vehicle Journey (SSE)",
          description:
            "Establishes a zero-gap Server-Sent Events (SSE) stream for tracking a single vehicle's journey in real time.\n\n" +
            "**Events emitted:**\n" +
            "- `journey:history`: Emitted upon connection if `since` parameter is provided.\n" +
            "- `journey:point`: Continuous live stream of every incoming telemetry record.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }, { cookieAuth: [] }],
          parameters: [
            {
              name: "imei",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "15-digit Device IMEI number",
            },
            {
              name: "orgId",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Optional Organization ID",
            },
            {
              name: "since",
              in: "query",
              required: false,
              schema: { type: "string", format: "date-time" },
              description: "ISO 8601 start timestamp for historical replay before live stream.",
            },
          ],
          responses: {
            "200": {
              description: "SSE connection established (Content-Type: text/event-stream).",
            },
            "400": {
              description: "Missing mandatory imei parameter.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "401": {
              description: "Unauthorized.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "404": {
              description: "Device not found in caller's organization.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Internal server error.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },

      // ─────────────────────────────────────────────────────────
      // ANALYTICS & HISTORY
      // ─────────────────────────────────────────────────────────
      "/api/v1/history": {
        get: {
          tags: ["Analytics & History"],
          summary: "Get Telemetry History & Trip Analytics",
          description:
            "Queries TimescaleDB hypertable logs for historical telemetry and aggregated metrics (total distance in km, driving vs. idle duration, max/avg speed, fuel consumption, and odometer readings).",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }, { cookieAuth: [] }],
          parameters: [
            {
              name: "imei",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "15-digit Device IMEI number",
            },
            {
              name: "orgId",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Optional Organization ID (derived automatically if omitted).",
            },
            {
              name: "start",
              in: "query",
              required: false,
              schema: { type: "string", format: "date-time" },
              description: "Start timestamp filter (ISO 8601). Defaults to 24 hours ago.",
            },
            {
              name: "end",
              in: "query",
              required: false,
              schema: { type: "string", format: "date-time" },
              description: "End timestamp filter (ISO 8601). Defaults to current time.",
            },
          ],
          responses: {
            "200": {
              description: "Telemetry history and trip summary retrieved successfully.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/HistoryResponse" },
                },
              },
            },
            "400": {
              description: "Missing imei or invalid date range format.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "401": {
              description: "Unauthorized.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "403": {
              description: "Forbidden - Access denied for requested device.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Internal server error.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Enter your JWT Bearer token (e.g. `eyJhbGciOi...`).",
        },
        apiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
          description: "Enter your Organization API key (e.g. `fv_live_...`).",
        },
        apiKeyAuthQuery: {
          type: "apiKey",
          in: "query",
          name: "apiKey",
          description: "Enter your Organization API key as a query parameter (e.g. `?apiKey=fv_live_...`).",
        },
        cookieAuth: {
          type: "apiKey",
          in: "cookie",
          name: "access_token",
          description: "HttpOnly session cookie automatically set upon login.",
        },
      },
      schemas: {
        TrackVehicleRequest: {
          type: "object",
          required: ["imeis"],
          properties: {
            imeis: {
              type: "array",
              description: "Array of 15-digit Device IMEIs (Max 50)",
              items: {
                type: "string",
                example: "353456789012345",
              },
            },
          },
        },
        TrackVehicleResponse: {
          type: "object",
          required: ["results"],
          properties: {
            results: {
              type: "array",
              items: {
                type: "object",
                required: ["imei", "found"],
                properties: {
                  imei: { type: "string" },
                  found: { type: "boolean" },
                  location: {
                    type: "object",
                    nullable: true,
                    properties: {
                      latitude: { type: "number" },
                      longitude: { type: "number" },
                      speed: { type: "number" },
                      angle: { type: "number" },
                      ignition: { type: "boolean" },
                      fuelLevelRaw: { type: "number", nullable: true },
                      odometer: { type: "number", nullable: true },
                      timestamp: { type: "string", format: "date-time" },
                      updatedAt: { type: "string", format: "date-time" },
                    },
                  },
                },
              },
            },
          },
        },
        ErrorResponse: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "string",
              example: "Unauthorized access to this organization",
            },
          },
        },
        LoginRequest: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: {
              type: "string",
              format: "email",
              example: "admin@myfleet.com",
            },
            password: {
              type: "string",
              format: "password",
              example: "securepassword123",
            },
          },
        },
        LoginResponse: {
          type: "object",
          properties: {
            user: { $ref: "#/components/schemas/User" },
            message: {
              type: "string",
              example: "Login successful",
            },
          },
        },
        RegisterOrgRequest: {
          type: "object",
          required: ["name", "adminEmail"],
          properties: {
            name: {
              type: "string",
              example: "Acme Fleet Solutions",
            },
            adminEmail: {
              type: "string",
              format: "email",
              example: "admin@acmefleet.com",
            },
            password: {
              type: "string",
              format: "password",
              example: "securePassword123!",
            },
          },
        },
        RegisterOrgResponse: {
          type: "object",
          properties: {
            organization: { $ref: "#/components/schemas/Organization" },
            user: { $ref: "#/components/schemas/User" },
          },
        },
        Organization: {
          type: "object",
          properties: {
            id: { type: "string", example: "cm0123456789" },
            name: { type: "string", example: "Acme Fleet Solutions" },
            apiKey: { type: "string", nullable: true, example: "fv_live_9f8e7d6c5b4a..." },
            status: { type: "string", example: "ACTIVE" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            _count: {
              type: "object",
              properties: {
                users: { type: "integer", example: 5 },
                devices: { type: "integer", example: 12 },
                vehicles: { type: "integer", example: 10 },
              },
            },
          },
        },
        User: {
          type: "object",
          properties: {
            id: { type: "string", example: "usr_9988776655" },
            email: { type: "string", example: "admin@acmefleet.com" },
            role: { type: "string", example: "ADMIN" },
            organizationId: { type: "string", example: "cm0123456789" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        RegisterVehicleRequest: {
          type: "object",
          required: ["plateNumber"],
          properties: {
            plateNumber: { type: "string", example: "ABC-1234" },
            make: { type: "string", example: "Toyota" },
            model: { type: "string", example: "Camry" },
            year: { type: "integer", example: 2023 },
            color: { type: "string", example: "Silver" },
            vin: { type: "string", example: "1HGCR2F83HA000000" },
            vehicleType: { type: "string", example: "SEDAN" },
            status: { type: "string", example: "ACTIVE" },
            fuelType: { type: "string", example: "PETROL" },
            maxFuelCapacity: { type: "number", example: 60.0 },
            orgId: { type: "string", example: "cm0123456789" },
          },
        },
        Vehicle: {
          type: "object",
          properties: {
            id: { type: "string", example: "veh_123456" },
            plateNumber: { type: "string", example: "ABC-1234" },
            make: { type: "string", nullable: true, example: "Toyota" },
            model: { type: "string", nullable: true, example: "Camry" },
            year: { type: "integer", nullable: true, example: 2023 },
            color: { type: "string", nullable: true, example: "Silver" },
            vin: { type: "string", nullable: true, example: "1HGCR2F83HA000000" },
            vehicleType: { type: "string", nullable: true, example: "SEDAN" },
            status: { type: "string", example: "ACTIVE" },
            fuelType: { type: "string", nullable: true, example: "PETROL" },
            maxFuelCapacity: { type: "number", nullable: true, example: 60.0 },
            bleFuelChannel: { type: "integer", nullable: true, example: 1 },
            organizationId: { type: "string", example: "cm0123456789" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            device: { $ref: "#/components/schemas/Device" },
          },
        },
        FuelCalibration: {
          type: "object",
          properties: {
            vehicleId: { type: "string", example: "veh_123456" },
            bleFuelChannel: { type: "integer", nullable: true, example: 1 },
          },
        },
        UpdateFuelCalibrationRequest: {
          type: "object",
          properties: {
            bleFuelChannel: { type: "integer", nullable: true, example: 2 },
          },
        },
        RegisterDeviceRequest: {
          type: "object",
          required: ["imei"],
          properties: {
            imei: { type: "string", example: "353456789012345" },
            orgId: { type: "string", example: "cm0123456789" },
          },
        },
        Device: {
          type: "object",
          properties: {
            id: { type: "string", example: "dev_987654" },
            imei: { type: "string", example: "353456789012345" },
            status: { type: "string", example: "ACTIVE" },
            organizationId: { type: "string", example: "cm0123456789" },
            vehicleId: { type: "string", nullable: true, example: "veh_123456" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            vehicle: { $ref: "#/components/schemas/Vehicle" },
          },
        },
        AssignDeviceRequest: {
          type: "object",
          properties: {
            vehicleId: {
              type: "string",
              nullable: true,
              example: "veh_123456",
              description: "Pass vehicle ID string to assign, or `null` to unassign.",
            },
          },
        },
        ApiKeyResponse: {
          type: "object",
          properties: {
            apiKey: {
              type: "string",
              nullable: true,
              example: "fv_live_a1b2c3d4e5f6...",
            },
          },
        },
        LiveLocation: {
          type: "object",
          properties: {
            deviceId: { type: "string", example: "dev_987654" },
            vehicleId: { type: "string", nullable: true, example: "veh_123456" },
            plateNumber: { type: "string", nullable: true, example: "ABC-1234" },
            latitude: { type: "number", example: 37.7749 },
            longitude: { type: "number", example: -122.4194 },
            speed: { type: "number", example: 45.5 },
            heading: { type: "number", example: 180 },
            ignition: { type: "boolean", example: true },
            batteryLevel: { type: "number", example: 12.8 },
            fuelLevelRaw: { type: "number", example: 45.2 },
            timestamp: { type: "string", format: "date-time" },
          },
        },
        TelemetryPoint: {
          type: "object",
          properties: {
            time: { type: "string", format: "date-time" },
            lat: { type: "number", example: 37.7749 },
            lng: { type: "number", example: -122.4194 },
            speed: { type: "number", example: 45.5 },
            ignition: { type: "boolean", example: true },
            fuelLevelRaw: { type: "number", example: 45.2 },
            odometer: { type: "number", example: 12050.2 },
          },
        },
        HistorySummary: {
          type: "object",
          properties: {
            totalDistanceKm: { type: "number", example: 120.5 },
            drivingDurationMinutes: { type: "integer", example: 150 },
            idleDurationMinutes: { type: "integer", example: 30 },
            maxSpeedKmh: { type: "integer", example: 85 },
            avgSpeedKmh: { type: "number", example: 48.2 },
            startTime: { type: "string", format: "date-time" },
            endTime: { type: "string", format: "date-time" },
            startOdometer: { type: "number", nullable: true, example: 12050.2 },
            endOdometer: { type: "number", nullable: true, example: 12170.7 },
          },
        },
        HistoryResponse: {
          type: "object",
          properties: {
            imei: { type: "string", example: "353456789012345" },
            orgId: { type: "string", example: "cm0123456789" },
            summary: { $ref: "#/components/schemas/HistorySummary" },
            route: {
              type: "array",
              items: { $ref: "#/components/schemas/TelemetryPoint" },
            },
            metadata: {
              type: "object",
              properties: {
                totalTelemetryPoints: { type: "integer", example: 50000 },
                returnedRoutePoints: { type: "integer", example: 1200 },
                simplified: { type: "boolean", example: true },
                queryTimeMs: { type: "integer", example: 450 },
              },
            },
          },
        },
      },
    },
  };

  return NextResponse.json(openApiSpec);
}
