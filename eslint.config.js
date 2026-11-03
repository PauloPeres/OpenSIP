import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'coverage/**', 'reports/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      complexity: ['error', 8],
      'max-lines-per-function': ['error', { max: 20, skipBlankLines: true, skipComments: true }],
      'max-depth': ['error', 3],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: false }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error'
    }
  },
  {
    // TypeScript already resolves every identifier; no-undef only duplicates it
    // and cannot see DOM or Node globals through the compiler's lib settings.
    files: ['**/*.{ts,tsx}'],
    rules: { 'no-undef': 'off' }
  },
  {
    files: ['tests/**/*.ts', 'scripts/**/*.mjs', '*.config.ts', 'cucumber.cjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        module: 'writable',
        require: 'readonly',
        __dirname: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly'
      }
    },
    rules: {
      'max-lines-per-function': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      'no-console': 'off',
      complexity: 'off'
    }
  }
);
