/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@fleet-vision/db"],
  serverExternalPackages: ["ioredis"],
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

// Triggered a hard restart to clear Prisma client from globalThis cache
