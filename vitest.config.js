import { defineConfig } from 'vitest/config';

// Node by default: the rules core, the wire layer and the data checks are all
// DOM-free and run faster without jsdom. Component tests opt in per-file with
// a `// @vitest-environment jsdom` comment at the top.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
  },
});
