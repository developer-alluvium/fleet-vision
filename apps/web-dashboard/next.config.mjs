/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: [
    "192.168.0.160",
    "192.168.0.*",
    "192.168.*.*",
    "192.168.**",
    "10.*.*.*",
    "10.**",
    "172.16.*.*",
    "localhost",
    "127.0.0.1",
    "whc3g027-8080.inc1.devtunnels.ms",
    "*.devtunnels.ms",
  ],
  transpilePackages: ["@fleet-vision/db"],
  serverExternalPackages: ["ioredis"],
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      bufferutil: false,
      "utf-8-validate": false,
    };
    return config;
  },
};

export default nextConfig;

// Triggered restart to reload Prisma client with SharedJourney model support at 2026-10-31
