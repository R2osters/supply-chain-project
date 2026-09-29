/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @scip/shared is a workspace package shipped as TypeScript-compiled CJS; Next needs to be
  // told to transpile it rather than treating it as a prebuilt ESM dependency.
  transpilePackages: ['@scip/shared'],
  eslint: { ignoreDuringBuilds: true },
  // Static export: the desktop app serves these files from its webview, with no Node server.
  output: 'export',
  // next/image optimisation needs a server; the export ships images as-is.
  images: { unoptimized: true },
};

export default nextConfig;
