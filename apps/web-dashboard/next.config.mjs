/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@fleet-vision/db"],
  serverExternalPackages: ["ioredis"],
};

export default nextConfig;
