import { defineConfig } from 'vitest/config';

// Standalone Vitest config (takes precedence over vite.config.ts) so the
// resume-refs virtual-module plugin doesn't load during unit tests — the tests
// exercise pure game logic, not the build-time content wiring.
export default defineConfig({
  test: {
    // Default to node; DOM-dependent specs opt in per file with
    // `// @vitest-environment jsdom` at the top.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
