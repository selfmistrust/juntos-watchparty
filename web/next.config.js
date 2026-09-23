/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  images: { remotePatterns: [{ protocol: 'https', hostname: 'i.ytimg.com' }] },
};
module.exports = nextConfig;
