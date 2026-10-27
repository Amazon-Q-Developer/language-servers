// Global test setup - runs before all tests
process.on('unhandledRejection', err => {
    // Only exit on unexpected errors, not legitimate AWS API errors in tests
    if (err && typeof err === 'object' && '$fault' in err) {
        // This is an AWS SDK error, likely from a test - don't exit
        console.warn('AWS API error in test (not terminating):', err)
        return
    }

    console.error('Unhandled rejection:', err)
    process.exit(1)
})
