import { NextResponse } from "next/server";

export async function GET() {
  const openApiSpec = {
    openapi: "3.0.0",
    info: {
      title: "Fleet Vision API Documentation",
      version: "1.0.0",
      description: "API specifications and testing console for Fleet Vision Enterprise platform.",
    },
    servers: [
      {
        url: "http://localhost:3000",
        description: "Local Development Server",
      },
    ],
    paths: {
      "/api/v1/organizations": {
        post: {
          summary: "Create Organization",
          description: "Creates a new organization and initial Admin User.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name", "adminEmail", "password"],
                  properties: {
                    name: { type: "string", example: "My Fleet" },
                    adminEmail: { type: "string", example: "admin@myfleet.com" },
                    password: { type: "string", example: "securepassword123" },
                  },
                },
              },
            },
          },
          responses: {
            "201": { description: "Organization Created" },
            "400": { description: "Invalid Input" },
            "409": { description: "Email already exists" },
          },
        },
        get: {
          summary: "List Organizations",
          description: "Lists all organizations with aggregated counts.",
          responses: {
            "200": { description: "Success" },
          },
        },
      },
      "/api/v1/vehicles": {
        post: {
          summary: "Add Vehicle",
          description: "Registers a new vehicle.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["plateNumber", "orgId"],
                  properties: {
                    plateNumber: { type: "string", example: "ABC-1234" },
                    make: { type: "string", example: "Toyota" },
                    model: { type: "string", example: "Camry" },
                    year: { type: "integer", example: 2022 },
                    color: { type: "string", example: "White" },
                    vin: { type: "string", example: "12345678901234567" },
                    vehicleType: { type: "string", example: "CAR" },
                    status: { type: "string", example: "ACTIVE" },
                    fuelType: { type: "string", example: "PETROL" },
                    maxFuelCapacity: { type: "number", example: 50.5 },
                    orgId: { type: "string", example: "org_id" },
                  },
                },
              },
            },
          },
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          responses: {
            "201": { description: "Vehicle Created" },
            "400": { description: "Invalid Input" },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden" },
            "404": { description: "Organization Not Found" },
            "409": { description: "Plate number or VIN already exists" },
          },
        },
        get: {
          summary: "List Vehicles",
          description: "Lists vehicles for a specific organization.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: "orgId",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "Organization ID",
            },
          ],
          responses: {
            "200": { description: "Success" },
            "400": { description: "Missing orgId parameter" },
          },
        },
      },
      "/api/v1/devices/{deviceId}/assign": {
        post: {
          summary: "Assign Vehicle to Device",
          description: "Assigns a vehicle to a GPS tracking device.",
          parameters: [
            {
              name: "deviceId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Device ID (CUID)",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    vehicleId: { type: "string", example: "vehicle_id", nullable: true },
                  },
                },
              },
            },
          },
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          responses: {
            "200": { description: "Device Updated" },
            "400": { description: "Vehicle belongs to a different organization" },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden" },
            "404": { description: "Device or Vehicle Not Found" },
            "409": { description: "Vehicle already assigned to another device" },
          },
        },
      },
      "/api/v1/devices": {
        post: {
          summary: "Register Device",
          description: "Registers a new telemetry device (IMEI) and syncs authorization to Redis cache.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["imei", "orgId"],
                  properties: {
                    imei: { type: "string", example: "353456789012345" },
                    orgId: { type: "string", example: "PASTE_ORG_ID_HERE" },
                  },
                },
              },
            },
          },
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          responses: {
            "201": { description: "Device Registered" },
            "400": { description: "Invalid Input" },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden" },
            "404": { description: "Organization Not Found" },
          },
        },
        get: {
          summary: "List Devices",
          description: "Lists devices for an organization. The `orgId` parameter is **optional** — the system will automatically derive the Organization ID from the caller's authentication token/key. If `orgId` is explicitly provided, it must match the authenticated user's organization.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: "orgId",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Optional Organization ID (derived automatically from Bearer Token / API Key if omitted)",
            },
          ],
          responses: {
            "200": { description: "Success" },
            "400": { description: "Missing orgId parameter when authentication is not provided" },
          },
        },
      },
      "/api/v1/live-locations": {
        get: {
          summary: "Get Live Locations",
          description: "Fetches real-time vehicle positions directly from Redis cache.",
          parameters: [
            {
              name: "orgId",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "Organization ID",
            },
          ],
          responses: {
            "200": { description: "Success" },
            "400": { description: "Missing orgId parameter" },
          },
        },
      },
      "/api/v1/stream/fleet": {
        get: {
          summary: "Stream Live Fleet Locations (SSE)",
          description: "Server-Sent Events stream for all vehicle locations in an organization. Requires authorization header or query parameter. Upon connection, immediately emits an `init` event containing all devices, their assigned vehicles, and latest known locations. Subsequent real-time location updates are emitted as `location:update` events.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [],
          responses: {
            "200": { description: "SSE Stream Connection Established" },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden" },
          },
        },
      },
      "/api/v1/journey": {
        get: {
          summary: "Get Historical Journey Trail",
          description: "Retrieves the ordered sequence of coordinates for a specific device.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: "imei",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "15-digit Device IMEI",
            },
            {
              name: "orgId",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Optional Organization ID (derived automatically from Bearer Token / API Key if omitted)",
            },
            {
              name: "since",
              in: "query",
              required: false,
              schema: { type: "string", format: "date-time" },
              description: "Start timestamp (ISO 8601). Defaults to 1 hour ago.",
            },
          ],
          responses: {
            "200": { description: "Success" },
            "400": { description: "Invalid/missing parameters" },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden" },
          },
        },
      },
      "/api/v1/stream/journey": {
        get: {
          summary: "Stream Live Journey – Per-Record Real-Time Tracking (SSE)",
          description: "Server-Sent Events stream for a single vehicle's journey. Streams EVERY individual telemetry record in real-time as the vehicle moves. Accepts optional 'since' parameter to first emit historical points (event: journey:history), then continuously streams live points (event: journey:point). Uses subscribe-first buffering to guarantee zero data gaps between history and live stream.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: "imei",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "15-digit Device IMEI",
            },
            {
              name: "orgId",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Optional Organization ID (derived automatically from Bearer Token / API Key if omitted)",
            },
            {
              name: "since",
              in: "query",
              required: false,
              schema: { type: "string", format: "date-time" },
              description: "Optional start timestamp (ISO 8601) to stream historical journey points before live tracking.",
            },
          ],
          responses: {
            "200": { description: "SSE Stream Connection Established" },
            "400": { description: "Invalid/missing parameters" },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden" },
            "404": { description: "Device not found in organization" },
          },
        },
      },
      "/api/v1/history": {
        get: {
          summary: "Get Telemetry History & Historical Journey Trail",
          description: "Retrieves historical telemetry records and journey logs from TimescaleDB for a specified device IMEI.\n\n### Authentication & Multi-Tenancy\nThis endpoint requires authentication via Bearer JWT token or Organization API key (`x-api-key` header).\nThe `orgId` parameter is **optional** — the system will automatically derive the Organization ID from the caller's authentication token/key. If `orgId` is explicitly provided, it must match the authenticated user's organization to prevent cross-tenant data access.\n\n### Time Range Filtering\n- `start` & `end`: ISO 8601 timestamps (e.g. `2026-08-07T00:00:00Z`).\n- If neither `start` nor `end` is provided, defaults to telemetry logs from the **last 24 hours**.\n- Output records are sorted in descending order by timestamp (up to a max of 10,000 records).",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
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
              description: "Optional Organization ID (derived automatically from Bearer Token / API Key if omitted)",
            },
            {
              name: "start",
              in: "query",
              required: false,
              schema: { type: "string", format: "date-time" },
              description: "Start timestamp filter (ISO 8601)",
            },
            {
              name: "end",
              in: "query",
              required: false,
              schema: { type: "string", format: "date-time" },
              description: "End timestamp filter (ISO 8601)",
            },
          ],
          responses: {
            "200": {
              description: "Telemetry history retrieved successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      imei: { type: "string", example: "353456789012345" },
                      orgId: { type: "string", example: "cm0123456789" },
                      summary: {
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
                        }
                      },
                      route: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            time: { type: "string", format: "date-time" },
                            lat: { type: "number", example: 37.7749 },
                            lng: { type: "number", example: -122.4194 },
                            speed: { type: "number", example: 45 },
                            ignition: { type: "boolean", example: true },
                            fuelLevelRaw: { type: "number", example: 50.5 },
                            odometer: { type: "number", example: 12050.2 },
                          }
                        },
                      },
                      metadata: {
                        type: "object",
                        properties: {
                          totalTelemetryPoints: { type: "integer", example: 50000 },
                          returnedRoutePoints: { type: "integer", example: 1200 },
                          simplified: { type: "boolean", example: true },
                          queryTimeMs: { type: "integer", example: 450 },
                        }
                      },
                    },
                  },
                },
              },
            },
            "400": { description: "Missing or invalid query parameters (e.g. invalid date format or missing imei)" },
            "401": { description: "Unauthorized - Invalid or missing authentication token / API key" },
            "403": { description: "Forbidden - Access denied for specified orgId" },
            "500": { description: "Internal server error" },
          },
        },
      },
      "/api/v1/auth/login": {
        post: {
          summary: "Organization User Login",
          description: "Authenticates a user and sets secure HttpOnly cookies for access and refresh tokens.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email", "password"],
                  properties: {
                    email: { type: "string", example: "admin@myfleet.com" },
                    password: { type: "string", example: "securepassword123" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Successful Login" },
            "401": { description: "Unauthorized" },
          },
        },
      },
      "/api/v1/auth/me": {
        get: {
          summary: "Get Current User",
          description: "Returns the authenticated user's details. If the access token is expired, it automatically uses the refresh token to issue new cookies.",
          responses: {
            "200": { description: "Success" },
            "401": { description: "Unauthorized" },
          },
        },
      },
      "/api/v1/auth/refresh": {
        post: {
          summary: "Refresh Token",
          description: "Issues a new access token and refresh token via HttpOnly cookies.",
          responses: {
            "200": { description: "Successful Refresh" },
            "401": { description: "Unauthorized or Invalid Refresh Token" },
          },
        },
      },
      "/api/v1/auth/logout": {
        post: {
          summary: "User Logout",
          description: "Revokes the refresh token and clears HttpOnly cookies.",
          responses: {
            "200": { description: "Successful Logout" },
          },
        },
      },
      "/api/v1/organizations/api-key": {
        post: {
          summary: "Generate API Key",
          description: "Generates a new API key for the organization. Requires JWT login token.",
          security: [{ bearerAuth: [] }],
          responses: {
            "201": { description: "API Key Generated" },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden (Requires JWT, not API key)" },
          },
        },
        get: {
          summary: "Get API Key",
          description: "Retrieves the currently stored API key. Requires JWT login token.",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { description: "Success" },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden (Requires JWT, not API key)" },
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
        },
        apiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
        },
      },
    },
  };

  return NextResponse.json(openApiSpec);
}
