/** Bundle lists for the ACP-only installation. */

/** Installation-owned defaults used when the ACP profile is first opened. */
export interface ProfileTemplate {
  /** Ordered bundle layer list. */
  bundles: readonly string[]
}

/** The sole shipped profile template. */
export const PROFILE_TEMPLATES: Record<string, ProfileTemplate> = {
  acp: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
  },
}

/** No legacy profile tuples need migration in this distribution. */
export const INSTALLATION_OWNED_PROFILE_TUPLES: Readonly<Record<string, readonly string[]>> = {}

/** No retired bundles need removal in this distribution. */
export const RETIRED_BUNDLES: ReadonlySet<string> = new Set()

/** Custom profiles start with the shared harness core. */
export const DEFAULT_PROFILE_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base']

/** This distribution carries no optional application bundles. */
export const OPTIONAL_BUNDLES: readonly string[] = []

/** This distribution carries no on-demand application bundles. */
export const ON_DEMAND_BUNDLES: readonly string[] = []
