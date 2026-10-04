const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // The server deliberately hides internals from clients; log instead.
      'no-console': 'error',
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none' }],
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        io: 'readonly',
      },
    },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
  },
];
