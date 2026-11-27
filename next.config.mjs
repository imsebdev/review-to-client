/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    optimizePackageImports: [],
    // /api/preview (review page v2): pdf.js and its native canvas run as plain Node packages,
    // not bundled by webpack. Only that route imports them.
    serverComponentsExternalPackages: ["pdfjs-dist", "@napi-rs/canvas"],
    // pdf.js reads its font/decoder data from disk at runtime; ship it with that route only.
    outputFileTracingIncludes: {
      "/api/preview": [
        "./node_modules/pdfjs-dist/standard_fonts/**",
        "./node_modules/pdfjs-dist/cmaps/**",
        "./node_modules/pdfjs-dist/wasm/**",
      ],
    },
  },
};

export default nextConfig;
