import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

export default defineConfig({
  plugins: [standardDecoratorPlugin(), tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    include: ['packages/acp/acp/tests/**/*.spec.ts'],
    environment: 'node',
    pool: 'forks',
    execArgv: vitestExecArgv,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
