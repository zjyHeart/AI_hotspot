import type { NextConfig } from "next";
const config: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["better-sqlite3", "jsdom"],
  devIndicators: false,
  outputFileTracingIncludes: { "/api/*": ["./drizzle/**/*"] },
};
export default config;
