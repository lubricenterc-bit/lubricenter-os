import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  // Las pruebas de componentes (.tsx) usan el JSX automático de React.
  oxc: { jsx: { runtime: 'automatic' } },
  test: { include: ['tests/**/*.test.ts', 'lib/**/*.test.ts'], testTimeout: 15000, hookTimeout: 120000, fileParallelism: false },
});
