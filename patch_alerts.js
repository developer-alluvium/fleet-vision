const fs = require('fs');
const file = 'apps/web-dashboard/src/app/api/v1/alerts/route.ts';
let code = fs.readFileSync(file, 'utf8');

// Replace the GET function
const newGet = `export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request);

    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get("page") || "1", 10);
    const limit = parseInt(searchParams.get("limit") || "20", 10);
    const category = searchParams.get("category");
    const eventType = searchParams.get("eventType");
    const geofenceId = searchParams.get("geofenceId");
    const imei = searchParams.get("imei");
    const vehicleId = searchParams.get("vehicleId");
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    const skip = (page - 1) * limit;

    const where: any = { organizationId: auth.organizationId };
    
    if (category) {
      where.category = category;
    }
    if (eventType) {
      where.eventType = eventType;
    }
    if (geofenceId) {
      where.geofenceId = geofenceId;
    }
    if (imei) {
      where.imei = imei;
    }
    if (from || to) {
      where.timestamp = {};
      if (from) where.timestamp.gte = new Date(from);
      if (to) where.timestamp.lte = new Date(to);
    }

    if (vehicleId) {
      const devices = await prisma.device.findMany({
        where: { vehicleId, organizationId: auth.organizationId },
        select: { imei: true }
      });
      const imeis = devices.map(d => d.imei);
      if (imeis.length > 0) {
        if (where.imei) {
          if (!imeis.includes(where.imei)) {
             // force empty result if imei filter contradicts vehicleId filter
             where.imei = "NO_MATCH"; 
          }
        } else {
          where.imei = { in: imeis };
        }
      } else {
         where.imei = "NO_MATCH";
      }
    }

    const [rawAlerts, totalCount] = await Promise.all([
      prisma.alert.findMany({
        where,
        orderBy: { timestamp: "desc" },
        skip,
        take: limit,
        include: {
          geofence: {
            select: { name: true, type: true }
          }
        }
      }),
      prisma.alert.count({ where }),
    ]);

    // Fetch related device and vehicle info based on imei
    const imeis = Array.from(new Set(rawAlerts.map(a => a.imei)));
    const devices = await prisma.device.findMany({
      where: {
        imei: { in: imeis },
        organizationId: auth.organizationId,
      },
      include: {
        vehicle: true,
      },
    });

    const deviceMap = new Map(devices.map(d => [d.imei, d]));

    const alerts = rawAlerts.map(alert => {
      const device = deviceMap.get(alert.imei);
      return {
        ...alert,
        device: device ? {
          id: device.id,
          imei: device.imei,
          vehicle: device.vehicle ? {
            id: device.vehicle.id,
            plateNumber: device.vehicle.plateNumber,
            make: device.vehicle.make,
            model: device.vehicle.model,
          } : null,
        } : null,
      };
    });

    return NextResponse.json({
      alerts,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
      page,
      limit,
    });
  } catch (error) {
    console.error(\`[API] GET /api/v1/alerts error:\`, error);
    if (error instanceof Error && (error.message.includes("Invalid token") || error.message.includes("Authentication required") || error.message.includes("Invalid or inactive API key"))) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}`;

code = code.replace(/export async function GET\(request: NextRequest\) \{[\s\S]*\}\s*$/m, newGet);

fs.writeFileSync(file, code);
