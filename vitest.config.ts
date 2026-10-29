import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  test: {
    include: ['tests/**/*.test.ts'],
    // Allow for local Worker startup on the first integration request.
    testTimeout: 15_000,
  },
});
