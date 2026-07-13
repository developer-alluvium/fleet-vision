import { PrismaClient } from "@prisma/client";

// Re-export all Prisma generated types for consumer packages
export * from "@prisma/client";

// Global singleton to prevent multiple PrismaClient instances in development
// (hot-reload creates new modules but we want to reuse the DB connection pool)
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "info", "warn", "error"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
