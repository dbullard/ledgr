import { readFileSync } from "node:fs";
import type { NextConfig } from "next";

// Single source of truth for the version the app reports (/api/health). Read at
// build time so a running container can be identified without guessing which
// image tag produced it.
const { version } = JSON.parse(readFileSync("./package.json", "utf8"));

const nextConfig: NextConfig = {
  output: "standalone",
  // Receipt OCR: the Tesseract worker, its WASM core, the bundled English model and
  // the native canvas are loaded at runtime, so file tracing must carry them into
  // the standalone image.
  serverExternalPackages: ["tesseract.js", "tesseract.js-core", "@napi-rs/canvas"],
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/tesseract.js/**/*",
      "./node_modules/tesseract.js-core/**/*",
      "./node_modules/@tesseract.js-data/eng/4.0.0_best_int/**/*",
      "./node_modules/@napi-rs/canvas*/**/*",
    ],
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
