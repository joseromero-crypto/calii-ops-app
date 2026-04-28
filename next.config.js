/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '20mb', // CSV uploads can be a few MB
    },
  },
  // Big CSVs benefit from streaming + edge-runtime caveats: keep parsing on Node runtime
  serverExternalPackages: ['papaparse'],
};

module.exports = nextConfig;
