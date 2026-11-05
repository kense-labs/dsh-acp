import { copyFileSync, cpSync, existsSync, globSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { build } from 'esbuild'

const root = process.cwd()
const manifests = globSync(['vendor/*/package.json', 'packages/*/*/package.json', 'apps/cli/package.json'], { cwd: root })
let assembled = 0
for (const manifest of manifests) {
  const packageDir = join(root, dirname(manifest))
  const emitted = join(packageDir, 'lib', 'types')
  if (!existsSync(emitted)) continue
  cpSync(emitted, join(packageDir, 'lib'), { recursive: true })
  assembled++
}
copyFileSync(join(root, 'vendor/schemastery/lib/index.js'), join(root, 'vendor/schemastery/lib/index.mjs'))
await build({
  entryPoints: [join(root, 'packages/session/session-persistence-jsonl/lib/worker.js')],
  outfile: join(root, 'packages/session/session-persistence-jsonl/lib/worker.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2024',
  banner: { js: 'const __import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
  define: { 'import.meta.url': '__import_meta_url' },
  plugins: [{
    name: 'workspace-bundle',
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (args.path.startsWith('@deepseek-ai/') && !args.path.startsWith('@deepseek-ai/node-addon-system')) return
        return { path: args.path, external: true }
      })
    },
  }],
})
console.log(`assemble-lib: prepared ${assembled} package(s)`)
