import { defineConfig } from 'vitest/config'

// src/raw 的测试不显式 import describe/it，因此统一启用 Vitest globals。
export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
  },
})
