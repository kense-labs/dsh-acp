/** Package presentation rules for the ACP-only installation. */

/** Plugins required by the launcher and harness core. */
export const PROTECTED_PLUGINS: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-plugin-manager', '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cordis-plugin-include', '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-host-plugin-inventory',
  '@deepseek-ai/dsh-typert-registry', '@deepseek-ai/dsh-api-remote-access',
  '@deepseek-ai/cordis-plugin-timer', '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-hmr',
])

/** Built-in ACP bundles have no separate plugin-manager page. */
export const HIDDEN_BUNDLES: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-acp-app',
])

/** No extension bundles are installed. */
export const EXTENSION_BUNDLES: readonly string[] = []

/** No additional bundles are installed. */
export const MORE_BUNDLES: readonly string[] = []

/** No experimental bundles are installed. */
export const EXPERIMENTAL_BUNDLES: ReadonlySet<string> = new Set()
