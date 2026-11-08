import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'release/**', 'build/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  { files: ['src/renderer/**'], languageOptions: { globals: { ...globals.browser } } },
  { files: ['**/*.mjs', '**/*.mts'], ...tseslint.configs.disableTypeChecked },
  { files: ['bin/hub'], languageOptions: { sourceType: 'commonjs' }, ...tseslint.configs.disableTypeChecked },
  { files: ['bin/hub'], rules: { '@typescript-eslint/no-require-imports': 'off' } },
);
