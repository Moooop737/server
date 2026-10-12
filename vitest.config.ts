import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    reporters: ['verbose'],
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts', 'test/**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', 'src/pipeline/chunk/legacy.test.ts'],
  },
})