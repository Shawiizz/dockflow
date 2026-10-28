import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  // plain files in out/, served by the Caddy container (Dockerfile)
  output: 'export',
  // the pages live at /start/installation/ and so on, as the CLI's links expect
  trailingSlash: true,
  reactStrictMode: true,
  images: { unoptimized: true },
};

export default withMDX(config);
