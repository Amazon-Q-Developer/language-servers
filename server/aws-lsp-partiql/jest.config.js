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

    // Coverage (npm run test:coverage) leaves out the generated parser code and the inline binaries
    coveragePathIgnorePatterns: [
        '/node_modules/',
        '/src/antlr-generated/',
        '/src/partiql-parser-wasm/',
        '/src/tree-sitter-wasm/',
    ],
}
