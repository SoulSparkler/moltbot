/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    externalDir: true,
  },
  serverExternalPackages: ["json5", "ws"],
};

export default nextConfig;
