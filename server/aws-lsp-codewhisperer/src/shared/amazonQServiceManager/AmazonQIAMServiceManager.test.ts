import { TestFeatures } from '@aws/language-server-runtimes/testing'
import { deepStrictEqual } from 'assert'
import sinon from 'ts-sinon'
import { AmazonQIAMServiceManager } from './AmazonQIAMServiceManager'
import { AmazonQServicePendingSigninError } from './errors'
import { CodeWhispererServiceIAM } from '../codeWhispererService'
import { generateSingletonInitializationTests } from './testUtils'
import * as utils from '../utils'

describe('AmazonQIAMServiceManager', () => {
    describe('Initialization process', () => {
        generateSingletonInitializationTests(AmazonQIAMServiceManager)
    })

    describe('Service caching', () => {
        let serviceManager: AmazonQIAMServiceManager
        let features: TestFeatures
        let updateCachedServiceConfigSpy: sinon.SinonSpy

        beforeEach(() => {
            features = new TestFeatures()

            updateCachedServiceConfigSpy = sinon.spy(
                AmazonQIAMServiceManager.prototype,
                'updateCachedServiceConfig' as keyof AmazonQIAMServiceManager
            )

            // Default: IAM credentials are present. Individual tests override this to exercise
            // the missing-credentials path.
            features.credentialsProvider.hasCredentials.withArgs('iam').returns(true)

            AmazonQIAMServiceManager.resetInstance()
            serviceManager = AmazonQIAMServiceManager.initInstance(features)
        })

        afterEach(() => {
            AmazonQIAMServiceManager.resetInstance()
            features.dispose()
            sinon.restore()
        })

        it('should initialize the CodeWhisperer service only once', () => {
            const service = serviceManager.getCodewhispererService()
            sinon.assert.calledOnce(updateCachedServiceConfigSpy)

            deepStrictEqual(serviceManager.getCodewhispererService(), service)
            sinon.assert.calledOnce(updateCachedServiceConfigSpy)
        })

        it('should initialize the streaming client only once', () => {
            // Mock the credentials provider to return credentials when requested
            features.credentialsProvider.hasCredentials.withArgs('iam').returns(true)
            features.credentialsProvider.getCredentials.withArgs('iam').returns({
                accessKeyId: 'dummy-access-key',
                secretAccessKey: 'dummy-secret-key',
                sessionToken: 'dummy-session-token',
            })

            const streamingClient = serviceManager.getStreamingClient()

            // Verify that getting the client again returns the same instance
            deepStrictEqual(serviceManager.getStreamingClient(), streamingClient)
        })

        it('should handle missing IAM credentials gracefully', () => {
            features.credentialsProvider.hasCredentials.withArgs('iam').returns(false)

            try {
                serviceManager.getCodewhispererService()
                throw new Error('Expected error was not thrown')
            } catch (error) {
                deepStrictEqual(error instanceof AmazonQServicePendingSigninError, true)
                deepStrictEqual((error as Error).message.includes('No IAM credentials available'), true)
            }
        })

        it('should not create or cache a service while IAM credentials are missing', () => {
            features.credentialsProvider.hasCredentials.withArgs('iam').returns(false)

            try {
                serviceManager.getCodewhispererService()
            } catch {
                // expected
            }

            sinon.assert.notCalled(updateCachedServiceConfigSpy)

            // Once credentials arrive the service is created normally
            features.credentialsProvider.hasCredentials.withArgs('iam').returns(true)
            const service = serviceManager.getCodewhispererService()
            deepStrictEqual(service instanceof CodeWhispererServiceIAM, true)
            sinon.assert.calledOnce(updateCachedServiceConfigSpy)
        })

        it('should validate credentials before creating service', () => {
            // hasCredentials is already a stub on TestFeatures; assert on it directly
            features.credentialsProvider.hasCredentials.withArgs('iam').returns(true)
            serviceManager.getCodewhispererService()

            sinon.assert.calledWith(features.credentialsProvider.hasCredentials, 'iam')
        })

        it('should return correct credential validation status', () => {
            features.credentialsProvider.hasCredentials.withArgs('iam').returns(true)
            deepStrictEqual(serviceManager.hasValidCredentials(), true)

            features.credentialsProvider.hasCredentials.withArgs('iam').returns(false)
            deepStrictEqual(serviceManager.hasValidCredentials(), false)
        })
    })
})
