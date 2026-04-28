/** @type {import('next').NextConfig} */
   const nextConfig = {
     experimental: {
       serverActions: {
         bodySizeLimit: '20mb',
       },
       serverComponentsExternalPackages: ['papaparse'],
     },
   };

   module.exports = nextConfig;
