import * as assert from 'assert'
import * as sinon from 'sinon'
import { TestFeatures } from '@aws/language-server-runtimes/testing'
import { captureCheckedTarget, CheckedTarget, readCheckedFile, updateCheckedFile, logFileAccess } from './checkedFileIo'
import { FileOperationError } from '../errors'
import { withCheckedFileOperations } from './checkedFileFixtures.test'

describe('checked file runtime delegation', () => {
    const target: CheckedTarget = { path: 'checked-target', state: 'existing', dev: '1', ino: '2', linkCount: '1' }
    let features: TestFeatures
    let read: sinon.SinonStub
    let update: sinon.SinonStub
    let capture: sinon.SinonStub
    let rawRead: sinon.SinonStub
    let rawWrite: sinon.SinonStub
    let platform: sinon.SinonStub

    beforeEach(() => {
        features = new TestFeatures()
        platform = sinon.stub(process, 'platform').value('linux')
        read = sinon.stub().resolves('fixture')
        update = sinon.stub().resolves({ mayHaveChanged: true, complete: true, target })
        capture = sinon.stub().resolves(target)
        rawRead = sinon.stub().resolves('before')
        rawWrite = sinon.stub().resolves()
        Object.assign(features.workspace.fs, {
            readFile: rawRead,
            writeFile: rawWrite,
            checkedFiles: { version: 1, capture, read, update },
        })
    })
    afterEach(() => sinon.restore())

    it('captures an immutable target and passes its identity to runtime reads', async () => {
        const checked = await captureCheckedTarget(features.workspace, target.path)
        assert.ok(Object.isFrozen(checked))
        assert.notStrictEqual(checked, target)
        assert.strictEqual(await readCheckedFile(features.workspace, checked), 'fixture')
        sinon.assert.calledOnceWithExactly(capture, target.path)
        sinon.assert.calledOnceWithExactly(read, checked)
        sinon.assert.notCalled(rawRead)
    })

    it('delegates one complete update and returns the actual handle outcome', async () => {
        const transform = (content: string) => content + ' after'
        const options = { create: true, readExisting: false }
        const outcome = await updateCheckedFile(features.workspace, target, transform, options)
        sinon.assert.calledOnceWithExactly(update, target, transform, options)
        assert.deepStrictEqual(outcome, { mayHaveChanged: true, complete: true, target })
        sinon.assert.notCalled(rawRead)
        sinon.assert.notCalled(rawWrite)
    })

    it('rejects absent, incompatible, and incomplete contracts before ordinary I/O', async () => {
        for (const capability of [
            undefined,
            { version: 0, read, update, capture },
            { version: '1', read, update, capture },
            { version: 1.5, read, update, capture },
            { version: NaN, read, update, capture },
            { version: 1, read, capture },
        ]) {
            features.workspace.fs.checkedFiles = capability as any
            await assert.rejects(captureCheckedTarget(features.workspace, target.path), FileOperationError)
            await assert.rejects(readCheckedFile(features.workspace, target), FileOperationError)
            await assert.rejects(
                updateCheckedFile(features.workspace, target, () => 'changed'),
                FileOperationError
            )
        }
        sinon.assert.notCalled(rawRead)
        sinon.assert.notCalled(rawWrite)
    })

    it('accepts a later additive contract version', async () => {
        features.workspace.fs.checkedFiles = { version: 2, read, update, capture }
        assert.strictEqual(await readCheckedFile(features.workspace, target), 'fixture')
        sinon.assert.calledOnceWithExactly(read, target)
        sinon.assert.notCalled(rawRead)
    })

    it('rejects unverified POSIX targets instead of capturing late or falling back', async () => {
        const unverified: CheckedTarget = { path: target.path, state: 'unverified' }
        await assert.rejects(readCheckedFile(features.workspace, unverified), /No checked file identity/)
        await assert.rejects(
            updateCheckedFile(features.workspace, unverified, () => 'changed'),
            /No checked file identity/
        )
        sinon.assert.notCalled(capture)
        sinon.assert.notCalled(rawRead)
        sinon.assert.notCalled(rawWrite)
    })

    it('preserves runtime errors without an unchecked fallback', async () => {
        const failure = Object.assign(new Error('Open failed'), { code: 'ESTALE' })
        read.rejects(failure)
        update.rejects(failure)
        await assert.rejects(readCheckedFile(features.workspace, target), error => error === failure)
        await assert.rejects(
            updateCheckedFile(features.workspace, target, () => 'changed'),
            error => error === failure
        )
        sinon.assert.notCalled(rawRead)
        sinon.assert.notCalled(rawWrite)
    })

    it('retains the Windows provider without exposing checked operations in fixtures', async () => {
        platform.value('win32')
        const windowsTarget = await captureCheckedTarget(features.workspace, 'C:\\workspace\\file.txt')
        assert.strictEqual(windowsTarget.state, 'unverified')
        assert.strictEqual(await readCheckedFile(features.workspace, windowsTarget), 'before')
        await updateCheckedFile(features.workspace, windowsTarget, text => text + ' after')
        sinon.assert.calledWithExactly(rawWrite, windowsTarget.path, 'before after')
        rawRead.resetHistory()
        await updateCheckedFile(features.workspace, windowsTarget, () => 'new', { create: true, readExisting: false })
        sinon.assert.notCalled(rawRead)
        sinon.assert.notCalled(capture)
        sinon.assert.notCalled(read)
        sinon.assert.notCalled(update)
        const fixture = withCheckedFileOperations(features.workspace.fs)
        assert.notStrictEqual(fixture, features.workspace.fs)
        assert.strictEqual(fixture.checkedFiles, undefined)
        assert.ok(features.workspace.fs.checkedFiles)
    })

    it('does not write when a Windows transform fails', async () => {
        platform.value('win32')
        await assert.rejects(
            updateCheckedFile(features.workspace, target, () => {
                throw new Error('Transform failed')
            }),
            /Transform failed/
        )
        sinon.assert.notCalled(rawWrite)
    })

    it('keeps diagnostics independent of operation errors and file content', async () => {
        const failure = Object.assign(new Error('private-message'), { code: 'ELOOP' })
        read.rejects(failure)
        const debug = sinon.stub()
        await assert.rejects(readCheckedFile(features.workspace, target, { debug }), error => error === failure)
        assert.ok(debug.firstCall.args[0].includes('ELOOP'))
        assert.ok(!debug.firstCall.args[0].includes('private-message'))
        logFileAccess(
            {
                debug: () => {
                    throw new Error('Unavailable')
                },
            },
            'example',
            { targetPath: target.path }
        )
    })
})
