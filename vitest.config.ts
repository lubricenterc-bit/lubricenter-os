import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts', 'lib/**/*.test.ts'], testTimeout: 15000, hookTimeout: 120000, fileParallelism: false } });
