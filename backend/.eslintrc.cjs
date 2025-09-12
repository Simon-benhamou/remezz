module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { project: false, sourceType: 'module', ecmaVersion: 'latest' },
  env: { node: true, es2022: true },
  plugins: ['@typescript-eslint', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:import/recommended',
    'plugin:import/typescript',
    'prettier',
  ],
  rules: {
    'import/order': ['warn', { 'newlines-between': 'always', alphabetize: { order: 'asc' } }],
    '@typescript-eslint/no-explicit-any': 'off',
  },
  ignorePatterns: ['dist/**', 'node_modules/**'],
};

