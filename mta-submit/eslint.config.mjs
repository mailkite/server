import js from '@eslint/js'
import globals from 'globals'
import { defineConfig, globalIgnores } from 'eslint/config'

// ESLint for the Haraka MX edge (plain CommonJS plugins). This package is not
// `type: module`, so the config itself is `.mjs`. Haraka injects the plugin-result
// constants (OK/CONT/DENY/DENYSOFT/…) and a few helpers as runtime globals into every
// plugin, so we declare them as read-only. See docs/CODING-STANDARDS.md §2.
const harakaGlobals = {
  OK: 'readonly',
  CONT: 'readonly',
  NEXT_HOOK: 'readonly',
  DECLINED: 'readonly',
  DENY: 'readonly',
  DENYSOFT: 'readonly',
  DENYDISCONNECT: 'readonly',
  DENYSOFTDISCONNECT: 'readonly',
  server: 'readonly',
  logger: 'readonly',
}

export default defineConfig([
  globalIgnores(['node_modules']),
  // Haraka plugins are CommonJS.
  {
    files: ['plugins/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, ...harakaGlobals },
    },
  },
  // Helper scripts are Node ESM.
  {
    files: ['scripts/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: 'module',
      globals: globals.node,
    },
  },
])
