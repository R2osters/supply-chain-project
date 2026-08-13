/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @scip/shared is a workspace package shipped as TypeScript-compiled CJS; Next needs to be
  // told to transpile it rather than treating it as a prebuilt ESM dependency.
  transpilePackages: ['@scip/shared'],
  eslint: { ignoreDuringBuilds: true },
  output: 'standalone',
};

export default nextConfig;
