export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: true }],
  },
  extensionsToTreatAsEsm: ['.ts'],
  testMatch: ['**/packages/engine/dist/test/**/*.test.js', '**/packages/engine/src/test/**/*.test.ts', '**/src/test/**/*.test.ts']
};
