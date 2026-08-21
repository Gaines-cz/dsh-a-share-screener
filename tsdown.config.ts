import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node20',
  dts: true,
  // Runtime imports stay external: the host provides these packages through the
  // profile's node_modules; bundling would duplicate host-owned instances.
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-jobs',
    '@deepseek-ai/schemastery',
  ],
})
