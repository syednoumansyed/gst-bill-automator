import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Set by the Dockerfile; Vercel and local builds keep the default output
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  serverExternalPackages: ["pdfjs-dist", "puppeteer", "puppeteer-core", "@sparticuz/chromium"],
  // Files read at runtime by the PDF renderer on Vercel
  outputFileTracingIncludes: {
    "/api/generate": [
      "./src/lib/fonts/*.woff2",
      "./node_modules/@sparticuz/chromium/bin/**",
      // pdf.js imports its worker dynamically, so tracing misses it
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
    ],
  },
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }] }];
  },
  webpack: (config) => {
    // pdfjs-dist has an optional canvas dependency that doesn't exist in Node
    config.resolve.alias.canvas = false;
    return config;
  },
};

export default nextConfig;
