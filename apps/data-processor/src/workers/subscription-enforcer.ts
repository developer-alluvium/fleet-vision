import { prisma, redis } from "@fleet-vision/db";

/**
 * Subscription Enforcer — Nightly Cron
 *
 * Suspends organizations whose subscription has expired:
 *   1. Find orgs where subscriptionEndDate < NOW() and status = 'ACTIVE'
 *   2. Set status to 'SUSPENDED'
 *   3. Delete all associated IMEI entries from the Redis auth cache
 *      so the data-processor drops their new telemetry data (saves storage costs)
 */
export async function enforceSubscriptions(): Promise<void> {
  console.log("[SUBSCRIPTION] Starting subscription enforcement check…");

  try {
    // ── 1. Find expired organizations ────────────────────────
    const expiredOrgs = await prisma.organization.findMany({
      where: {
        status: "ACTIVE",
        subscriptionEndDate: {
          lt: new Date(),
        },
      },
      include: {
        devices: {
          select: { imei: true },
        },
      },
    });

    if (expiredOrgs.length === 0) {
      console.log("[SUBSCRIPTION] ✓ No expired subscriptions found");
      return;
    }

    console.log(
      `[SUBSCRIPTION] Found ${expiredOrgs.length} expired organization(s)`
    );

    for (const org of expiredOrgs) {
      // ── 2. Suspend the organization ──────────────────────
      await prisma.organization.update({
        where: { id: org.id },
        data: { status: "SUSPENDED" },
      });

      // ── 3. Revoke all device auth from Redis ─────────────
      const pipeline = redis.pipeline();
      for (const device of org.devices) {
        pipeline.del(`auth:${device.imei}`);
      }
      await pipeline.exec();

      console.log(
        `[SUBSCRIPTION] ✓ Suspended org "${org.name}" (${org.id}), ` +
          `revoked ${org.devices.length} device(s) from auth cache`
      );
    }

    console.log("[SUBSCRIPTION] ✓ Subscription enforcement complete");
  } catch (err) {
    console.error("[SUBSCRIPTION] ✗ Error during enforcement:", err);
  }
}
