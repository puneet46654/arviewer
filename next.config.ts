import type { NextConfig } from 'next';

const arAssetHeaders = [
  {
    key: 'Content-Disposition',
    value: 'inline',
  },
  {
    key: 'Access-Control-Allow-Origin',
    value: '*',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,

  async headers() {
    return [
      {
        source: '/:path*.usdz',
        headers: [
          {
            key: 'Content-Type',
            value: 'model/vnd.usdz+zip',
          },
          ...arAssetHeaders,
        ],
      },
      {
        source: '/:path*.reality',
        headers: [
          {
            key: 'Content-Type',
            value: 'model/vnd.reality',
          },
          ...arAssetHeaders,
        ],
      },
    ];
  },
};

export default nextConfig;