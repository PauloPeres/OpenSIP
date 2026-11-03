module.exports = {
  default: {
    import: ['tests/features/steps/**/*.ts'],
    paths: ['tests/features/**/*.feature'],
    loader: ['tsx/esm'],
    format: ['progress-bar', 'summary'],
    strict: true
  }
};
