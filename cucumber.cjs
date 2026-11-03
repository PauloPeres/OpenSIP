// tsx is loaded through NODE_OPTIONS="--import tsx" in the `test:bdd` script,
// because Node >= 20.6 rejects ESM loaders passed via `--loader`.
module.exports = {
  default: {
    import: ['tests/features/steps/**/*.ts'],
    paths: ['tests/features/**/*.feature'],
    format: ['progress-bar', 'summary'],
    strict: true
  }
};
