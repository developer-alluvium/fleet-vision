const fs = require('fs');
const file = 'apps/web-dashboard/src/app/api/openapi.json/route.ts';
let code = fs.readFileSync(file, 'utf8');

const oldParameters = `          parameters: [
            {
              name: "page",
              in: "query",
              required: false,
              schema: { type: "integer", default: 1 },
            },
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", default: 20 },
            },
            {
              name: "category",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Filter by category (e.g., 'SPEED', 'GEOFENCE')",
            },
            {
              name: "imei",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Filter by specific device IMEI",
            },
          ],`;

const newParameters = `          parameters: [
            {
              name: "page",
              in: "query",
              required: false,
              schema: { type: "integer", default: 1 },
            },
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", default: 20 },
            },
            {
              name: "category",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Filter by category (e.g., 'SPEED', 'GEOFENCE')",
            },
            {
              name: "eventType",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Filter by eventType (e.g., 'ENTER', 'EXIT')",
            },
            {
              name: "geofenceId",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Filter by geofence ID",
            },
            {
              name: "imei",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Filter by specific device IMEI",
            },
            {
              name: "vehicleId",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Filter by specific vehicle ID",
            },
            {
              name: "from",
              in: "query",
              required: false,
              schema: { type: "string", format: "date-time" },
              description: "Start date for timestamp filtering",
            },
            {
              name: "to",
              in: "query",
              required: false,
              schema: { type: "string", format: "date-time" },
              description: "End date for timestamp filtering",
            },
          ],`;

if (code.includes(oldParameters)) {
  code = code.replace(oldParameters, newParameters);
  fs.writeFileSync(file, code);
  console.log("Updated openapi parameters successfully.");
} else {
  console.log("Could not find old parameters block.");
}
