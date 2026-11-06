import { expect } from 'chai'
import {
    ATX_TEST_RUN_SCHEMA_VERSION,
    AtxAppLaunchRequest,
    AtxAppLaunchResult,
    AtxTestRunRequest,
    AtxTestRunSummary,
    isSupportedAtxTestRunSchemaVersion,
} from '../atxModels'

// From a real run on Bob's Used Bookstore (original code), reshaped to contract v0 schema 1.0:
// the artifact id is a mock value. Same data as the VS extension's contract tests.
const bobsBookstoreRequestJson = `{
    "schemaVersion": "1.0",
    "runId": "r1",
    "side": "original",
    "project": "Bookstore.Web",
    "artifactId": "mock-bobs-bookstore-repo",
    "tests": { "projectPath": "ITGen/Bookstore.IntegrationTests/Bookstore.IntegrationTests.csproj" },
    "limits": { "projectTimeoutSeconds": 1800 }
}`

const bobsBookstoreSummaryJson = `{
    "schemaVersion": "1.0",
    "runId": "r1",
    "side": "original",
    "project": "Bookstore.Web",
    "status": "COMPLETED",
    "appUrl": "http://localhost:57150",
    "startedAt": "2026-10-21T08:28:07-07:00",
    "finishedAt": "2026-10-21T08:28:09-07:00",
    "durationSeconds": 2,
    "counts": { "total": 24, "passed": 23, "failed": 1, "pending": 0 },
    "failingTests": [
        {
            "name": "Bookstore.IntegrationTests.ShoppingCartTests.AddItemToShoppingCart_RedirectsToSearch_AndBookAppearsInCart",
            "message": "Assert.Equal() Failure: Values differ. Expected: OK, Actual: InternalServerError (GET /ShoppingCart)"
        }
    ]
}`

describe('atxModels test-run contract', () => {
    describe('isSupportedAtxTestRunSchemaVersion', () => {
        it('accepts the current schema version', () => {
            expect(isSupportedAtxTestRunSchemaVersion(ATX_TEST_RUN_SCHEMA_VERSION)).to.equal(true)
        })

        it('accepts a newer minor version of the same major version', () => {
            expect(isSupportedAtxTestRunSchemaVersion('1.3')).to.equal(true)
        })

        it('rejects a different major version', () => {
            expect(isSupportedAtxTestRunSchemaVersion('2.0')).to.equal(false)
            expect(isSupportedAtxTestRunSchemaVersion('0.9')).to.equal(false)
        })

        it('rejects missing, non-string, and malformed versions', () => {
            for (const version of [undefined, null, 1, 1.0, '', '1', '1.', 'v1.0', '1.0.0', ' 1.0']) {
                expect(isSupportedAtxTestRunSchemaVersion(version), String(version)).to.equal(false)
            }
        })
    })

    describe('AtxTestRunRequest', () => {
        it('parses the Bob’s Bookstore request and round-trips it', () => {
            const request: AtxTestRunRequest = JSON.parse(bobsBookstoreRequestJson)

            expect(isSupportedAtxTestRunSchemaVersion(request.schemaVersion)).to.equal(true)
            expect(request.side).to.equal('original')
            expect(request.artifactId).to.equal('mock-bobs-bookstore-repo')
            expect(request.tests.projectPath).to.equal(
                'ITGen/Bookstore.IntegrationTests/Bookstore.IntegrationTests.csproj'
            )
            expect(request.limits.projectTimeoutSeconds).to.equal(1800)
            expect(JSON.parse(JSON.stringify(request))).to.deep.equal(JSON.parse(bobsBookstoreRequestJson))
        })

        it('keeps the repo artifact id on the transformed side', () => {
            const request: AtxTestRunRequest = {
                schemaVersion: ATX_TEST_RUN_SCHEMA_VERSION,
                runId: 'p5',
                side: 'transformed',
                project: 'SampleWebApi.Admin',
                artifactId: '9d2c41e7-sample-web-api-repo',
                tests: {
                    projectPath: 'GeneratedApiTests.SampleWebApi.Admin/GeneratedApiTests.SampleWebApi.Admin.csproj',
                },
                limits: { projectTimeoutSeconds: 1800 },
            }

            const json = JSON.parse(JSON.stringify(request))

            expect(json.artifactId).to.equal('9d2c41e7-sample-web-api-repo')
            expect(Object.keys(json).sort()).to.deep.equal(
                ['artifactId', 'limits', 'project', 'runId', 'schemaVersion', 'side', 'tests'].sort()
            )
        })

        it('carries the testOrder the agent asks for, and leaves it out when it does not', () => {
            const base: AtxTestRunRequest = {
                schemaVersion: ATX_TEST_RUN_SCHEMA_VERSION,
                runId: 'r3',
                side: 'original',
                project: 'SampleWebApi',
                artifactId: '9d2c41e7-sample-web-api-repo',
                tests: { projectPath: 'GeneratedApiTests.SampleWebApi/GeneratedApiTests.SampleWebApi.csproj' },
                limits: { projectTimeoutSeconds: 1800 },
            }

            // The second of the 2 orders a suite passes in before the agent freezes it; the IDE sets AB_TEST_ORDER
            expect(JSON.parse(JSON.stringify({ ...base, testOrder: 'reverse' })).testOrder).to.equal('reverse')

            // A 1.0 request carries no testOrder, and the suite orders by name itself
            expect(Object.keys(JSON.parse(JSON.stringify(base)))).to.not.include('testOrder')
        })
    })

    describe('AtxTestRunSummary', () => {
        it('parses the Bob’s Bookstore summary and round-trips it', () => {
            const summary: AtxTestRunSummary = JSON.parse(bobsBookstoreSummaryJson)

            expect(isSupportedAtxTestRunSchemaVersion(summary.schemaVersion)).to.equal(true)
            expect(summary.status).to.equal('COMPLETED')
            expect(summary.startedAt).to.equal('2026-10-21T08:28:07-07:00')
            expect(summary.counts).to.deep.equal({ total: 24, passed: 23, failed: 1, pending: 0 })
            expect(summary.failingTests).to.have.length(1)
            expect(JSON.parse(JSON.stringify(summary))).to.deep.equal(JSON.parse(bobsBookstoreSummaryJson))
        })
    })

    describe('AtxAppLaunchRequest and AtxAppLaunchResult', () => {
        // The real first launch of Bob's Used Bookstore (original code): HTTP 500 on the health check.
        const bobsBookstoreLaunchResultJson = `{
    "schemaVersion": "1.0",
    "side": "original",
    "project": "Bookstore.Web",
    "attempt": 1,
    "status": "APP_NOT_STARTED",
    "appUrl": "http://localhost:57150",
    "healthCheck": { "path": "/", "httpStatus": 500 },
    "error": "Could not load file or assembly 'System.ValueTuple, Version=4.0.0.0, Culture=neutral, PublicKeyToken=cc7b13ffcd2ddd51' or one of its dependencies. The system cannot find the file specified.",
    "logFile": "app-startup.log",
    "durationSeconds": 9
}`

        it('parses the Bob’s Bookstore failed launch and round-trips it', () => {
            const result: AtxAppLaunchResult = JSON.parse(bobsBookstoreLaunchResultJson)

            expect(isSupportedAtxTestRunSchemaVersion(result.schemaVersion)).to.equal(true)
            expect(result.status).to.equal('APP_NOT_STARTED')
            expect(result.healthCheck).to.deep.equal({ path: '/', httpStatus: 500 })
            expect(result.logFile).to.equal('app-startup.log')
            expect(JSON.parse(JSON.stringify(result))).to.deep.equal(JSON.parse(bobsBookstoreLaunchResultJson))
        })

        it('sends only the web project when the health-check defaults apply', () => {
            const request: AtxAppLaunchRequest = {
                schemaVersion: ATX_TEST_RUN_SCHEMA_VERSION,
                side: 'transformed',
                project: 'SampleWebApi',
                attempt: 2,
                app: { webProject: 'SampleWebApi/SampleWebApi.csproj' },
            }

            const json = JSON.parse(JSON.stringify(request))

            expect(json.attempt).to.equal(2)
            expect(Object.keys(json.app)).to.deep.equal(['webProject'])
        })

        it('reports a started launch without error or log file', () => {
            const result: AtxAppLaunchResult = {
                schemaVersion: ATX_TEST_RUN_SCHEMA_VERSION,
                side: 'transformed',
                project: 'SampleWebApi',
                attempt: 2,
                status: 'STARTED',
                appUrl: 'http://localhost:5003',
                healthCheck: { path: '/', httpStatus: 200 },
                durationSeconds: 14,
            }

            const json = JSON.parse(JSON.stringify(result))

            expect(json.status).to.equal('STARTED')
            expect(json).to.not.have.property('error')
            expect(json).to.not.have.property('logFile')
        })
    })
})
