import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'

const reactHooksCompilerRules = {
  'react-hooks/purity': 'off',
  'react-hooks/set-state-in-effect': 'warn',
  'react-hooks/set-state-in-render': 'off',
  'react-hooks/static-components': 'off',
  'react-hooks/refs': 'off',
  'react-hooks/immutability': 'off',
  'react-hooks/preserve-manual-memoization': 'off',
  'react-hooks/use-memo': 'off',
  'react-hooks/incompatible-library': 'off',
  'react-hooks/exhaustive-effect-dependencies': 'off',
  'react-hooks/memo-dependencies': 'off',
  'react-hooks/memoized-effect-dependencies': 'off',
  'react-hooks/no-deriving-state-in-effects': 'off',
}

const eslintConfig = defineConfig([
  ...nextVitals,
  {
    rules: {
      ...reactHooksCompilerRules,
      'react/no-unescaped-entities': 'off',
      'react-hooks/exhaustive-deps': 'warn',
      '@next/next/no-img-element': 'warn',
    },
  },
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'node_modules/**',
    'scripts/**',
    'next-env.d.ts',
  ]),
])

export default eslintConfig
