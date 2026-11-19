import { expect } from 'chai'
import * as sinon from 'sinon'
import { ItGenJobGate, objectiveHasIntegrationTests } from '../itgenJobGate'

describe('ItGenJobGate', () => {
    const itGenObjective = JSON.stringify({ generate_integration_tests: true })
    let readObjective: sinon.SinonStub
    let gate: ItGenJobGate

    beforeEach(() => {
        readObjective = sinon.stub()
        gate = new ItGenJobGate(readObjective, () => {})
    })

    it('reads a job once and remembers it', async () => {
        readObjective.resolves({ objective: itGenObjective })

        expect(await gate.isItGenJob('ws', 'job-1')).to.be.true
        expect(await gate.isItGenJob('ws', 'job-1')).to.be.true
        expect(gate.isKnownItGenJob('job-1')).to.be.true
        expect(readObjective.callCount).to.equal(1)
    })

    it('does not remember a failed read', async () => {
        readObjective.onFirstCall().resolves(null)
        readObjective.onSecondCall().resolves({ objective: itGenObjective })

        expect(await gate.isItGenJob('ws', 'job-1')).to.be.false
        expect(gate.isKnown('job-1')).to.be.false
        expect(await gate.isItGenJob('ws', 'job-1')).to.be.true
        expect(readObjective.callCount).to.equal(2)
    })

    it('never reads a job for isKnownItGenJob', () => {
        expect(gate.isKnownItGenJob('job-unknown')).to.be.false
        expect(readObjective.called).to.be.false
    })

    it('forgets a job, so the next check reads it again', async () => {
        gate.rememberFlag('job-1', true)
        gate.forget('job-1')
        readObjective.resolves({ objective: JSON.stringify({}) })

        expect(gate.isKnown('job-1')).to.be.false
        expect(await gate.isItGenJob('ws', 'job-1')).to.be.false
        expect(readObjective.callCount).to.equal(1)
    })

    it(`keeps at most ${ItGenJobGate.maxJobs} jobs, dropping the oldest`, () => {
        for (let i = 0; i <= ItGenJobGate.maxJobs; i++) {
            gate.rememberFlag(`job-${i}`, true)
        }

        expect(gate.isKnown('job-0')).to.be.false
        expect(gate.isKnown('job-1')).to.be.true
        expect(gate.isKnown(`job-${ItGenJobGate.maxJobs}`)).to.be.true
    })

    it('keeps a job that is remembered again as the newest', () => {
        gate.rememberFlag('job-keep', true)
        for (let i = 0; i < ItGenJobGate.maxJobs - 1; i++) {
            gate.rememberFlag(`job-${i}`, true)
        }
        gate.rememberFlag('job-keep', true)
        gate.rememberFlag('job-new', true)

        expect(gate.isKnown('job-keep')).to.be.true
        expect(gate.isKnown('job-0')).to.be.false
    })

    describe('isBeamItGenJob (a beamed repo, whose job is the parent web job)', () => {
        let clock: number
        let readBeamOptIn: sinon.SinonStub
        let log: sinon.SinonStub
        let beamGate: ItGenJobGate

        beforeEach(() => {
            clock = 1_000_000
            readBeamOptIn = sinon.stub()
            log = sinon.stub()
            readObjective.resolves({ objective: '{}' })
            beamGate = new ItGenJobGate(readObjective, log, readBeamOptIn, () => clock)
        })

        it('turns on when the beam-map opts in, and reads it only once', async () => {
            readBeamOptIn.resolves(true)

            expect(await beamGate.isBeamItGenJob('ws', 'web-1')).to.be.true
            expect(await beamGate.isBeamItGenJob('ws', 'web-1')).to.be.true
            expect(beamGate.isKnownItGenJob('web-1')).to.be.true
            expect(readBeamOptIn.callCount).to.equal(1)
            expect(log.calledWithMatch(/web-1 has a beamed repo with generateIntegrationTests/)).to.be.true
        })

        it('never reads the beam-map when the objective already opts in', async () => {
            readObjective.resolves({ objective: itGenObjective })

            expect(await beamGate.isBeamItGenJob('ws', 'job-1')).to.be.true
            expect(readBeamOptIn.called).to.be.false
        })

        it("doesn't read a beam-map without an opt-in again this session; a later opt-in comes from discovery", async () => {
            readBeamOptIn.resolves(false)

            expect(await beamGate.isBeamItGenJob('ws', 'web-1')).to.be.false
            clock += 24 * 60 * 60_000
            expect(await beamGate.isBeamItGenJob('ws', 'web-1')).to.be.false
            expect(readBeamOptIn.callCount).to.equal(1)

            // listBeamedRepos (the dashboard's discovery) records a repo beamed later with the flag
            beamGate.rememberBeamOptIn('web-1')
            expect(await beamGate.isBeamItGenJob('ws', 'web-1')).to.be.true
            expect(readBeamOptIn.callCount).to.equal(1)
        })

        it(`tries again after ${ItGenJobGate.beamRetryMs} ms when the beam-map couldn't be read`, async () => {
            readBeamOptIn.resolves(undefined)

            expect(await beamGate.isBeamItGenJob('ws', 'web-1')).to.be.false
            clock += ItGenJobGate.beamRetryMs - 1
            expect(await beamGate.isBeamItGenJob('ws', 'web-1')).to.be.false
            expect(readBeamOptIn.callCount).to.equal(1)

            readBeamOptIn.resolves(true)
            clock += 1
            expect(await beamGate.isBeamItGenJob('ws', 'web-1')).to.be.true
        })

        it('waits twice as long after each unconfirmed read, and stops at the cap with "no"', async () => {
            readBeamOptIn.resolves('unconfirmed')
            const readsAfter = async (ms: number) => {
                clock += ms
                expect(await beamGate.isBeamItGenJob('ws', 'web-1')).to.be.false
                return readBeamOptIn.callCount
            }

            await beamGate.isBeamItGenJob('ws', 'web-1')
            expect(await readsAfter(ItGenJobGate.beamRetryMs)).to.equal(2)
            expect(await readsAfter(2 * ItGenJobGate.beamRetryMs - 1)).to.equal(2)
            expect(await readsAfter(1)).to.equal(3)
            expect(await readsAfter(4 * ItGenJobGate.beamRetryMs)).to.equal(4)
            expect(await readsAfter(8 * ItGenJobGate.beamRetryMs)).to.equal(ItGenJobGate.beamMaxReadsThatCannotTell)
            expect(log.calledWithMatch(/web-1: 5 beam-map reads couldn't tell/)).to.be.true

            expect(await readsAfter(24 * 60 * 60_000)).to.equal(
                ItGenJobGate.beamMaxReadsThatCannotTell,
                'not read again'
            )
            // A repo beamed later still comes from discovery.
            beamGate.rememberBeamOptIn('web-1')
            expect(await beamGate.isBeamItGenJob('ws', 'web-1')).to.be.true
        })

        it('never gives up on reads that did not happen (throttled or cut short)', async () => {
            readBeamOptIn.resolves(undefined)

            await beamGate.isBeamItGenJob('ws', 'web-1')
            for (let i = 0; i < 2 * ItGenJobGate.beamMaxReadsThatCannotTell; i++) {
                clock += ItGenJobGate.beamRetryMs
                await beamGate.isBeamItGenJob('ws', 'web-1')
            }
            expect(readBeamOptIn.callCount).to.equal(2 * ItGenJobGate.beamMaxReadsThatCannotTell + 1, 'every 60 s')

            readBeamOptIn.resolves(true)
            clock += ItGenJobGate.beamRetryMs
            expect(await beamGate.isBeamItGenJob('ws', 'web-1')).to.be.true
        })

        it('starts the count over once a read can tell', async () => {
            readBeamOptIn.resolves('unconfirmed')
            await beamGate.isBeamItGenJob('ws', 'web-1')
            clock += ItGenJobGate.beamRetryMs
            await beamGate.isBeamItGenJob('ws', 'web-1')
            readBeamOptIn.resolves(false)
            clock += 2 * ItGenJobGate.beamRetryMs
            await beamGate.isBeamItGenJob('ws', 'web-1')

            beamGate.forget('web-1')
            readBeamOptIn.resolves('unconfirmed')
            await beamGate.isBeamItGenJob('ws', 'web-1')
            clock += ItGenJobGate.beamRetryMs
            await beamGate.isBeamItGenJob('ws', 'web-1')

            expect(readBeamOptIn.callCount).to.equal(5, 'the first retry after the answer is back to beamRetryMs')
        })

        it('in the background: answers at once, starts one read, and is on from the next call', async () => {
            let release!: (optIn: boolean) => void
            readBeamOptIn.returns(new Promise<boolean>(resolve => (release = resolve)))

            expect(await beamGate.isBeamItGenJob('ws', 'web-1', false)).to.be.false
            expect(await beamGate.isBeamItGenJob('ws', 'web-1', false)).to.be.false
            expect(readBeamOptIn.callCount).to.equal(1)

            release(true)
            await Promise.resolve()
            await Promise.resolve()
            expect(await beamGate.isBeamItGenJob('ws', 'web-1', false)).to.be.true
        })

        it('logs a failed read and tries again later', async () => {
            readBeamOptIn.rejects(new Error('throttled'))

            expect(await beamGate.isBeamItGenJob('ws', 'web-1')).to.be.false
            expect(log.calledWithMatch(/couldn't read the beam-map of job web-1: Error: throttled/)).to.be.true

            readBeamOptIn.resolves(true)
            clock += ItGenJobGate.beamRetryMs
            expect(await beamGate.isBeamItGenJob('ws', 'web-1')).to.be.true
        })

        it('reads the beam-map again after the job is forgotten', async () => {
            readBeamOptIn.resolves(false)
            await beamGate.isBeamItGenJob('ws', 'web-1')

            beamGate.forget('web-1')
            await beamGate.isBeamItGenJob('ws', 'web-1')

            expect(readBeamOptIn.callCount).to.equal(2)
        })

        it('is off without a beam-map reader', async () => {
            expect(await gate.isBeamItGenJob('ws', 'web-1')).to.be.false
        })
    })

    it('reads generate_integration_tests only as a real true', () => {
        expect(objectiveHasIntegrationTests(itGenObjective)).to.be.true
        expect(objectiveHasIntegrationTests(JSON.stringify({ generate_integration_tests: 'true' }))).to.be.false
        expect(objectiveHasIntegrationTests('{not json')).to.be.false
        expect(objectiveHasIntegrationTests(undefined)).to.be.false
    })
})
