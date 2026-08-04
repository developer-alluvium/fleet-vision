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
          description: "Lists devices for a specific organization.",
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
          description: "Server-Sent Events stream for all vehicle locations in an organization. Requires authorization header or query parameter.",
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
            "200": { description: "SSE Stream Connection Established" },
            "400": { description: "Missing orgId parameter" },
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
              required: true,
              schema: { type: "string" },
              description: "Organization ID",
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
          summary: "Stream Live Journey Updates (SSE)",
          description: "Server-Sent Events stream for a single vehicle's movement. Accepts optional 'since' parameter to fetch and stream historical points before continuing with real-time updates.",
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
              required: true,
              schema: { type: "string" },
              description: "Organization ID",
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
          summary: "Get Telemetry History",
          description: "Retrieves historical telemetry records from TimescaleDB for a given IMEI.",
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
              required: true,
              schema: { type: "string" },
              description: "Organization ID",
            },
            {
              name: "start",
              in: "query",
              required: false,
              schema: { type: "string", format: "date-time" },
              description: "Start timestamp (ISO 8601)",
            },
            {
              name: "end",
              in: "query",
              required: false,
              schema: { type: "string", format: "date-time" },
              description: "End timestamp (ISO 8601)",
            },
          ],
          responses: {
            "200": { description: "Success" },
            "400": { description: "Invalid/missing parameters" },
          },
        },
      },
      "/api/v1/auth/login": {
        post: {
          summary: "Organization User Login",
          description: "Authenticates a user and returns a JWT token.",
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
