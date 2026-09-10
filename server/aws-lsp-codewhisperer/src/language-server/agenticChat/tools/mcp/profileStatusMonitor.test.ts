/*!
 * Copyright Amazon.com, Inc. or its affiliates.
 * All Rights Reserved. SPDX-License-Identifier: Apache-2.0
 */

import * as chai from 'chai'
import * as sinon from 'sinon'
import { ProfileStatusMonitor } from './profileStatusMonitor'
import * as AmazonQTokenServiceManagerModule from '../../../../shared/amazonQServiceManager/AmazonQTokenServiceManager'
import { McpRegistryService } from './mcpRegistryService'

const { expect } = chai

interface MockLogging {
    info: sinon.SinonStub
    debug: sinon.SinonStub
    error: sinon.SinonStub
    warn: sinon.SinonStub
    log: sinon.SinonStub
}

describe('ProfileStatusMonitor', () => {
    let profileStatusMonitor: ProfileStatusMonitor
    let mockLogging: MockLogging
    let mockOnMcpDisabled: sinon.SinonStub
    let mockOnMcpEnabled: sinon.SinonStub
    let clock: sinon.SinonFakeTimers

    beforeEach(() => {
        clock = sinon.useFakeTimers()

        mockLogging = {
            info: sinon.stub(),
            debug: sinon.stub(),
            error: sinon.stub(),
            warn: sinon.stub(),
            log: sinon.stub(),
        }

        mockOnMcpDisabled = sinon.stub()
        mockOnMcpEnabled = sinon.stub()

        profileStatusMonitor = new ProfileStatusMonitor(mockLogging, mockOnMcpDisabled, mockOnMcpEnabled)
    })

    afterEach(() => {
        clock.restore()
        sinon.restore()
        profileStatusMonitor.stop()
    })

    describe('start', () => {
        it('should start monitoring and log info message', () => {
            profileStatusMonitor.start()

            expect(
                mockLogging.info.calledWith('ProfileStatusMonitor started - checking MCP configuration every 24 hours')
            ).to.be.true
        })

        it('should not start multiple times', () => {
            profileStatusMonitor.start()
            profileStatusMonitor.start()

            expect(mockLogging.info.callCount).to.equal(1)
        })
    })

    describe('stop', () => {
        it('should stop monitoring and log info message', () => {
            profileStatusMonitor.start()
            profileStatusMonitor.stop()

            expect(mockLogging.info.calledWith('ProfileStatusMonitor stopped')).to.be.true
        })
    })

    describe('checkInitialState', () => {
        it('should return true when no profile ARN is available', async () => {
            sinon.stub(AmazonQTokenServiceManagerModule.AmazonQTokenServiceManager, 'getInstance').returns({
                getActiveProfileArn: () => undefined,
            } as any)

            const result = await profileStatusMonitor.checkInitialState()
            expect(result).to.be.true
        })

        it('should throw error when isMcpEnabled throws non-registry error', async () => {
            // Stub the private isMcpEnabled method to throw an error
            sinon.stub(profileStatusMonitor as any, 'isMcpEnabled').throws(new Error('Service manager not ready'))

            try {
                await profileStatusMonitor.checkInitialState()
                expect.fail('Should have thrown an error')
            } catch (error) {
                expect(error).to.be.instanceOf(Error)
                expect((error as Error).message).to.equal('Service manager not ready')
            }
        })

        it('should disable MCP and call onMcpDisabled when registry error occurs', async () => {
            sinon.stub(profileStatusMonitor as any, 'isMcpEnabled').throws(new Error('MCP Registry: Failed to fetch'))
            ;(ProfileStatusMonitor as any).setMcpState(true)

            try {
                await profileStatusMonitor.checkInitialState()
                expect.fail('Should have thrown an error')
            } catch (error) {
                expect(error).to.be.instanceOf(Error)
                expect((error as Error).message).to.include('MCP Registry:')
                expect(ProfileStatusMonitor.getMcpState()).to.be.false
                expect(mockOnMcpDisabled.called).to.be.true
            }
        })

        it('should not disable MCP for non-registry errors', async () => {
            sinon.stub(profileStatusMonitor as any, 'isMcpEnabled').throws(new Error('Network error'))
            ;(ProfileStatusMonitor as any).setMcpState(true)

            try {
                await profileStatusMonitor.checkInitialState()
                expect.fail('Should have thrown an error')
            } catch (error) {
                expect(ProfileStatusMonitor.getMcpState()).to.be.true
                expect(mockOnMcpDisabled.called).to.be.false
            }
        })
    })

    describe('getMcpState', () => {
        beforeEach(() => {
            // Reset static state before each test
            ;(ProfileStatusMonitor as any).lastMcpState = undefined
        })

        it('should return undefined initially', () => {
            expect(ProfileStatusMonitor.getMcpState()).to.be.undefined
        })

        it('should return the last MCP state after it is set', () => {
            // Access the private static property through reflection for testing
            ;(ProfileStatusMonitor as any).lastMcpState = true
            expect(ProfileStatusMonitor.getMcpState()).to.be.true
            ;(ProfileStatusMonitor as any).lastMcpState = false
            expect(ProfileStatusMonitor.getMcpState()).to.be.false
        })

        it('should be accessible across different instances', () => {
            const monitor1 = new ProfileStatusMonitor(mockLogging, mockOnMcpDisabled, mockOnMcpEnabled)
            const monitor2 = new ProfileStatusMonitor(mockLogging, mockOnMcpDisabled, mockOnMcpEnabled)

            // Set state through static property
            ;(ProfileStatusMonitor as any).lastMcpState = true

            // Should be accessible from both instances
            expect(ProfileStatusMonitor.getMcpState()).to.be.true
        })
    })

    describe('static lastMcpState', () => {
        beforeEach(() => {
            // Reset static state before each test
            ;(ProfileStatusMonitor as any).lastMcpState = undefined
        })

        it('should maintain state across multiple instances', () => {
            const monitor1 = new ProfileStatusMonitor(mockLogging, mockOnMcpDisabled, mockOnMcpEnabled)
            const monitor2 = new ProfileStatusMonitor(mockLogging, mockOnMcpDisabled, mockOnMcpEnabled)

            // Initially true (default value)
            expect(ProfileStatusMonitor.getMcpState()).to.be.true

            // Set through internal mechanism (simulating state change)
            ;(ProfileStatusMonitor as any).lastMcpState = false

            // Both instances should see the same state
            expect(ProfileStatusMonitor.getMcpState()).to.be.false
        })
    })

    describe('registry URL handling', () => {
        let mockOnRegistryUpdate: sinon.SinonStub
        let mockServiceManager: any

        beforeEach(() => {
            mockOnRegistryUpdate = sinon.stub().resolves()

            mockServiceManager = {
                getActiveProfileArn: sinon.stub().returns('arn:aws:iam::123456789012:profile/test'),
                getCodewhispererService: sinon.stub().returns({
                    getProfile: sinon.stub().resolves({
                        profile: {
                            optInFeatures: {
                                mcpConfiguration: {
                                    toggle: 'ON',
                                    mcpRegistryUrl: 'https://example.com/registry.json',
                                },
                            },
                        },
                    }),
                }),
                getConnectionType: sinon.stub().returns('identityCenter'),
            }

            sinon
                .stub(AmazonQTokenServiceManagerModule.AmazonQTokenServiceManager, 'getInstance')
                .returns(mockServiceManager as any)
        })

        it('should notify registry URL for enterprise users when MCP is enabled', async () => {
            profileStatusMonitor = new ProfileStatusMonitor(
                mockLogging,
                mockOnMcpDisabled,
                mockOnMcpEnabled,
                mockOnRegistryUpdate
            )

            await profileStatusMonitor.checkInitialState()

            expect(mockOnRegistryUpdate.called).to.be.true
            expect(mockOnRegistryUpdate.firstCall.args[0]).to.be.a('string')
        })

        it('should throw error when registry fetch fails for enterprise users', async () => {
            mockOnRegistryUpdate.rejects(new Error('MCP Registry: Failed to fetch or validate registry'))

            profileStatusMonitor = new ProfileStatusMonitor(
                mockLogging,
                mockOnMcpDisabled,
                mockOnMcpEnabled,
                mockOnRegistryUpdate
            )

            try {
                await profileStatusMonitor.checkInitialState()
                expect.fail('Should have thrown an error')
            } catch (error) {
                expect(error).to.be.instanceOf(Error)
                expect((error as Error).message).to.include('MCP Registry:')
                expect(mockLogging.error.calledWith(sinon.match('MCP configuration check failed'))).to.be.true
            }
        })

        it('should not notify registry URL for free tier users', async () => {
            mockServiceManager.getConnectionType.returns('builderId')

            profileStatusMonitor = new ProfileStatusMonitor(
                mockLogging,
                mockOnMcpDisabled,
                mockOnMcpEnabled,
                mockOnRegistryUpdate
            )

            await profileStatusMonitor.checkInitialState()

            expect(mockOnRegistryUpdate.called).to.be.false
        })

        it('should not notify registry URL when MCP toggle is OFF', async () => {
            mockServiceManager.getCodewhispererService().getProfile.resolves({
                profile: {
                    optInFeatures: {
                        mcpConfiguration: {
                            toggle: 'OFF',
                        },
                    },
                },
            })

            profileStatusMonitor = new ProfileStatusMonitor(
                mockLogging,
                mockOnMcpDisabled,
                mockOnMcpEnabled,
                mockOnRegistryUpdate
            )

            await profileStatusMonitor.checkInitialState()

            expect(mockOnRegistryUpdate.called).to.be.false
        })

        it('should return registry URL from getRegistryUrl for enterprise users', async () => {
            // Create a new getProfile stub that returns mcpRegistryUrl
            const getProfileStub = sinon.stub().resolves({
                profile: {
                    optInFeatures: {
                        mcpConfiguration: {
                            mcpRegistryUrl: 'https://example.com/registry.json',
                        },
                    },
                },
            })

            mockServiceManager.getCodewhispererService = sinon.stub().returns({
                getProfile: getProfileStub,
            })

            profileStatusMonitor = new ProfileStatusMonitor(
                mockLogging,
                mockOnMcpDisabled,
                mockOnMcpEnabled,
                mockOnRegistryUpdate
            )

            const registryUrl = await profileStatusMonitor.getRegistryUrl()
            expect(registryUrl).to.equal('https://example.com/registry.json')
        })

        it('should return null from getRegistryUrl for free tier users', async () => {
            mockServiceManager.getConnectionType.returns('builderId')

            profileStatusMonitor = new ProfileStatusMonitor(
                mockLogging,
                mockOnMcpDisabled,
                mockOnMcpEnabled,
                mockOnRegistryUpdate
            )

            const registryUrl = await profileStatusMonitor.getRegistryUrl()
            expect(registryUrl).to.be.null
        })
    })

    describe('GetProfile call coalescing', () => {
        let mockServiceManager: any
        let getProfileStub: sinon.SinonStub

        const profileResponse = {
            profile: {
                optInFeatures: {
                    mcpConfiguration: {
                        toggle: 'ON',
                    },
                },
            },
        }

        beforeEach(() => {
            getProfileStub = sinon.stub().resolves(profileResponse)
            mockServiceManager = {
                getActiveProfileArn: sinon.stub().returns('arn:aws:iam::123456789012:profile/test'),
                getCodewhispererService: sinon.stub().returns({ getProfile: getProfileStub }),
                getConnectionType: sinon.stub().returns('builderId'),
            }

            sinon
                .stub(AmazonQTokenServiceManagerModule.AmazonQTokenServiceManager, 'getInstance')
                .returns(mockServiceManager as any)
        })

        it('should share a single GetProfile call between concurrent checks', async () => {
            const first = (profileStatusMonitor as any).isMcpEnabled()
            const second = (profileStatusMonitor as any).isMcpEnabled()

            const results = await Promise.all([first, second])

            expect(results).to.deep.equal([true, true])
            expect(getProfileStub.callCount).to.equal(1)
        })

        it('should allow a new check once the previous one has completed', async () => {
            await (profileStatusMonitor as any).isMcpEnabled()
            await (profileStatusMonitor as any).isMcpEnabled()

            expect(getProfileStub.callCount).to.equal(2)
        })

        it('should not repeat GetProfile for the same profile within the auth event cooldown', async () => {
            await (profileStatusMonitor as any).onAuthSuccess()
            await (profileStatusMonitor as any).onAuthSuccess()
            await (profileStatusMonitor as any).onAuthSuccess()

            expect(getProfileStub.callCount).to.equal(1)

            clock.tick(ProfileStatusMonitor.AUTH_EVENT_MIN_INTERVAL_MS)
            await (profileStatusMonitor as any).onAuthSuccess()

            expect(getProfileStub.callCount).to.equal(2)
        })

        it('should check immediately when the active profile changes', async () => {
            await (profileStatusMonitor as any).onAuthSuccess()
            expect(getProfileStub.callCount).to.equal(1)

            mockServiceManager.getActiveProfileArn.returns('arn:aws:iam::123456789012:profile/other')
            await (profileStatusMonitor as any).onAuthSuccess()

            expect(getProfileStub.callCount).to.equal(2)
        })

        it('should apply the cooldown even when the check fails', async () => {
            const serverError = Object.assign(new Error('Internal error'), { statusCode: 500 })
            getProfileStub.rejects(serverError)

            const firstAttempt = (profileStatusMonitor as any).onAuthSuccess()
            // retryWithBackoff waits between attempts; advance the fake clock so it can finish
            await clock.tickAsync(5000)
            await firstAttempt
            const callsAfterFirstEvent = getProfileStub.callCount
            expect(callsAfterFirstEvent).to.be.greaterThan(0)

            await (profileStatusMonitor as any).onAuthSuccess()

            expect(getProfileStub.callCount).to.equal(callsAfterFirstEvent)
            expect(mockLogging.debug.calledWith(sinon.match('checked recently'))).to.be.true
        })
    })

    describe('isEnterpriseUser', () => {
        let mockServiceManager: any

        beforeEach(() => {
            mockServiceManager = {
                getConnectionType: sinon.stub(),
            }
        })

        it('should return true for identityCenter connection type', () => {
            mockServiceManager.getConnectionType.returns('identityCenter')

            const result = (profileStatusMonitor as any).isEnterpriseUser(mockServiceManager)

            expect(result).to.be.true
            expect(mockLogging.info.called).to.be.false
        })

        it('should return false for builderId connection type', () => {
            mockServiceManager.getConnectionType.returns('builderId')

            const result = (profileStatusMonitor as any).isEnterpriseUser(mockServiceManager)

            expect(result).to.be.false
            expect(mockLogging.info.calledWith(sinon.match('not on Pro Tier/IdC'))).to.be.true
        })

        it('should log governance unavailable message for non-enterprise users', () => {
            mockServiceManager.getConnectionType.returns('builderId')

            const result = (profileStatusMonitor as any).isEnterpriseUser(mockServiceManager)

            expect(result).to.be.false
            expect(mockLogging.info.calledWith(sinon.match('governance features unavailable'))).to.be.true
        })
    })
})
