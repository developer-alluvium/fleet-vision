/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@fleet-vision/db"],
  serverExternalPackages: ["ioredis"],
};

export default nextConfig;

// Triggered a hard restart to clear Prisma client from globalThis cache
