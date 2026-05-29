import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // This targets all .usdz files in your public directory
        source: '/:path*\\.usdz',
        headers: [
          {
            key: 'Content-Type',
            value: 'model/vnd.usdz+zip',
          },
          {
             key: 'Cache-Control',
             value: 'public, max-age=3600',
          }
        ],
      },
    ];
  },
};

export default nextConfig;
