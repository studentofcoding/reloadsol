import path from 'node:path'
import { defineConfig, type Plugin } from 'vitest/config'

const stubCss: Plugin = {
  name: 'stub-css',
  load(id) {
    if (id.includes('.css')) return 'export default {}'
    return undefined
  },
}

export default defineConfig({
  plugins: [stubCss],
  test: {
    environment: 'node',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
