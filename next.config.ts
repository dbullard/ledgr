import { readFileSync } from "node:fs";
import type { NextConfig } from "next";

// Single source of truth for the version the app reports (/api/health). Read at
// build time so a running container can be identified without guessing which
// image tag produced it.
const { version } = JSON.parse(readFileSync("./package.json", "utf8"));

const nextConfig: NextConfig = {
  output: "standalone",
  // Receipt OCR loads tesseract.js and @napi-rs/canvas at runtime (worker threads,
  // WASM, native code), so they must stay external. In Docker they come from
  // OCR_MODULES_DIR (see the ocr-deps stage in the Dockerfile).
  serverExternalPackages: ["tesseract.js", "tesseract.js-core", "@napi-rs/canvas"],
  experimental: {
    // Receipt photos, PDFs and order-history spreadsheets are uploaded through server
    // actions; the 1 MB default would reject an ordinary phone photo.
    serverActions: { bodySizeLimit: "20mb" },
  },
  env: {
    APP_VERSION: version,
  },
  // Bills became Recurrings; keep old bookmarks and links working.
  async redirects() {
    return [{ source: "/bills", destination: "/recurrings", permanent: false }];
  },
};

export default nextConfig;
