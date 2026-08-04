import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage'] },

  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  // UI-only plugins. These rules are meaningless outside React components and
  // would just add noise to the headless code.
  {
    files: ['src/ui/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
  },

  // domain/ and solver/ must stay pure and headless - testable in Node with no
  // DOM. This is the mechanical half of that guarantee; the "no React, nothing
  // from src/ui/" half is enforced by the import restriction below.
  {
    files: ['src/domain/**/*.ts', 'src/solver/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'domain/ and solver/ must stay DOM-free.' },
        { name: 'document', message: 'domain/ and solver/ must stay DOM-free.' },
        { name: 'navigator', message: 'domain/ and solver/ must stay DOM-free.' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['react', 'react-dom', '**/ui/**'], message: 'domain/ and solver/ must stay headless.' },
          ],
        },
      ],
    },
  },

  // The solver must be deterministic given the same inputs and seed.
  // Math.random() would silently break reproducibility - use solver/rng.ts.
  {
    files: ['src/solver/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the seeded PRNG in solver/rng.ts - the solver must be deterministic.' },
      ],
    },
  },
);
