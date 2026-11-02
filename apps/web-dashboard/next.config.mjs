/** @type {import('next').NextConfig} */
const nextConfig = {
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
