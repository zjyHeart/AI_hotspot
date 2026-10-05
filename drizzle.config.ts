import { defineConfig } from 'drizzle-kit';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const { loadEnvConfig }=createRequire(resolve(process.cwd(),'package.json'))('@next/env');
loadEnvConfig(process.cwd());
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/server/schema.ts',
  out: './drizzle',
  dbCredentials: { url: (process.env.DATABASE_URL || './data/hotspot.db').replace(/^file:/, '') },
});
