const tsPreset = require('ts-jest/jest-preset')

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    transform: {
        ...tsPreset.transform,
        [`partiql_playground.js`]: require.resolve('./test-utils/esm-transformer'),
    },
    transformIgnorePatterns: [...(tsPreset.transformIgnorePatterns || [])],

    // The test environment that will be used for testing
    testEnvironment: 'node',

    // The glob patterns Jest uses to detect test files
    testMatch: ['**/*.test.ts?(x)'],

    // Coverage (npm run test:coverage) counts every source file, also one that no test imports, and leaves out the
    // generated parser code and the inline binaries
    collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.test.{ts,tsx}', '!src/**/*.d.ts'],
    coveragePathIgnorePatterns: [
        '/node_modules/',
        '/src/antlr-generated/',
        '/src/partiql-parser-wasm/',
        '/src/tree-sitter-wasm/',
    ],
}
