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

    it('reads generate_integration_tests only as a real true', () => {
        expect(objectiveHasIntegrationTests(itGenObjective)).to.be.true
        expect(objectiveHasIntegrationTests(JSON.stringify({ generate_integration_tests: 'true' }))).to.be.false
        expect(objectiveHasIntegrationTests('{not json')).to.be.false
        expect(objectiveHasIntegrationTests(undefined)).to.be.false
    })
})
