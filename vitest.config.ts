import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    reporters: ['verbose'],
    environment: 'node',
    setupFiles: ['./test/setup-env.ts'],
    /* 共享真库：retrieve-chain 会临时插 768 维行，和并行检索/入库用例互相污染。文件级串行。 */
    fileParallelism: false,
    include: ['src/**/*.{test,spec}.ts', 'test/**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', 'test/legacy.test.ts'],
  },
})