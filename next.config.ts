import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  async rewrites() {
    return [
      {
        source: '/authcallback',
        destination: '/api/auth/callback/linuxdo',
      },
    ]
  },
};

export default nextConfig;
