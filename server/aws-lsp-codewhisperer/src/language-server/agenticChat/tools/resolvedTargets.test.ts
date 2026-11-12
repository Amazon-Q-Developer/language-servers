import * as assert from 'assert'
import * as sinon from 'sinon'
import { TestFeatures } from '@aws/language-server-runtimes/testing'
import { newAgent } from '@aws/language-server-runtimes/runtimes/agent'
import { FsToolsServer } from './toolServer'
import { FsRead } from './fsRead'
import { FsWrite } from './fsWrite'
import { FsReplace } from './fsReplace'
import { FileSearch } from './fileSearch'
import { ListDirectory } from './listDirectory'
import * as shared from './toolShared'
import * as checkedIo from './checkedFileIo'
import { workspaceUtils } from '@aws/lsp-core'

const checked = (path: string): checkedIo.CheckedTarget => ({
    path,
    state: 'existing',
    dev: '1',
    ino: '2',
    linkCount: '1',
})

describe('checked filesystem targets', () => {
    const tools = [
        { name: 'fsRead', prototype: FsRead.prototype, input: { paths: ['alias'] } },
        {
            name: 'fsWrite',
            prototype: FsWrite.prototype,
            input: { path: 'alias', command: 'create', fileText: 'fixture' },
        },
        { name: 'fsReplace', prototype: FsReplace.prototype, input: { path: 'alias', diffs: [] } },
        { name: 'fileSearch', prototype: FileSearch.prototype, input: { path: 'alias', queryName: 'fixture' } },
        { name: 'listDirectory', prototype: ListDirectory.prototype, input: { path: 'alias' } },
    ]
    const pending: object[] = []
    afterEach(() => {
        pending.splice(0).forEach(shared.discardResolvedTargets)
        sinon.restore()
    })
    function prepare(input: object, name: string, paths: string[]) {
        const prepared = shared.withResolvedTargets(input, name, paths.map(checked))
        pending.push(prepared)
        return prepared
    }

    it('copies and freezes target metadata independently of the decision and input', () => {
        const original = { path: 'alias' }
        const target = { path: 'checked-target', state: 'existing' as const, dev: '1', ino: '2', linkCount: '1' }
        const targets = [target]
        const input = shared.withResolvedTargets(original, 'fsWrite', targets)
        target.ino = 'changed'
        targets.length = 0
        const retained = shared.requireResolvedTarget(input, 'fsWrite')
        assert.deepStrictEqual(retained, checked('checked-target'))
        assert.ok(Object.isFrozen(retained))
        assert.deepStrictEqual(input, original)
        assert.notStrictEqual(input, original)
    })

    it('rejects fabricated, copied, cross-tool, replayed, and discarded handoffs', () => {
        const input = prepare({ path: 'alias' }, 'fsRead', ['checked-target'])
        for (const untrusted of [{}, { __resolvedTargets: checked('fabricated') }, { ...input }]) {
            assert.throws(() => shared.requireResolvedTarget(untrusted, 'fsRead'), /No checked targets/)
        }
        assert.throws(() => shared.requireResolvedTarget(input, 'fsWrite'), /No checked targets/)
        assert.deepStrictEqual(shared.requireResolvedTarget(input, 'fsRead'), checked('checked-target'))
        assert.throws(() => shared.requireResolvedTarget(input, 'fsRead'), /No checked targets/)
        const discarded = prepare({}, 'fsRead', ['one'])
        shared.discardResolvedTargets(discarded)
        assert.throws(() => shared.requireResolvedTarget(discarded, 'fsRead'), /No checked targets/)
        const mismatched = prepare({}, 'fsRead', ['one', 'two'])
        assert.throws(() => shared.requireResolvedTargets(mismatched, 'fsRead', 1), /do not match/)
        assert.throws(() => shared.requireResolvedTargets(mismatched, 'fsRead', 2), /No checked targets/)
    })

    it('keeps overlapping invocations separate in reverse completion order', async () => {
        const first = prepare({}, 'fsWrite', ['first'])
        const second = prepare({}, 'fsWrite', ['second'])
        assert.deepStrictEqual(
            await Promise.all([
                Promise.resolve().then(() => shared.requireResolvedTarget(second, 'fsWrite')),
                Promise.resolve().then(() => shared.requireResolvedTarget(first, 'fsWrite')),
            ]),
            [checked('second'), checked('first')]
        )
    })

    for (const { name, prototype, input } of tools) {
        it(`${name} passes the same checked target through validation and invocation`, async () => {
            const validate = sinon.stub(prototype, 'validate').resolves()
            const invoke = sinon.stub(prototype, 'invoke').resolves({ output: { kind: 'text', content: 'fixture' } })
            const features = new TestFeatures()
            FsToolsServer(features)
            const handler = (features.agent.addTool as sinon.SinonStub).getCalls().find(c => c.args[0].name === name)!
                .args[1]
            const prepared = prepare(input, name, ['checked-target'])
            await handler(prepared)
            sinon.assert.calledOnce(validate)
            sinon.assert.calledOnce(invoke)
            const target =
                name === 'fsRead'
                    ? [checked('checked-target')]
                    : ['listDirectory', 'fileSearch'].includes(name)
                      ? 'checked-target'
                      : checked('checked-target')
            assert.deepStrictEqual(validate.firstCall.args[1], target)
            assert.strictEqual(validate.firstCall.args[1], invoke.firstCall.args[1])
            await assert.rejects(handler(prepared), /No checked targets/)
            await assert.rejects(handler(input), /No checked targets/)
        })
    }

    it('retains identity through runtime dispatch and keeps mutation metadata out of model output', async () => {
        const features = new TestFeatures()
        features.agent = newAgent()
        const outcome = { mayHaveChanged: true, complete: true, target: checked('checked-target') as any }
        sinon.stub(FsWrite.prototype, 'validate').resolves()
        const output = { kind: 'text' as const, content: 'fixture' }
        sinon.stub(FsWrite.prototype, 'invoke').resolves({ output, fileUpdate: outcome })
        const dispose = FsToolsServer(features)
        try {
            const input = prepare({ path: 'alias', command: 'create', fileText: 'fixture' }, 'fsWrite', [
                'checked-target',
            ])
            assert.deepStrictEqual(await features.agent.runTool('fsWrite', input), { output })
            assert.deepStrictEqual(shared.getFileUpdate(input), outcome)
            await assert.rejects(features.agent.runTool('fsWrite', input), /No checked targets/)
            shared.discardResolvedTargets(input)
            assert.strictEqual(shared.getFileUpdate(input), undefined)
        } finally {
            dispose()
        }
    })

    it('returns no executable target for empty or whitespace-only input', async () => {
        const features = new TestFeatures()
        for (const path of ['', '   ']) {
            const result = await shared.requiresPathAcceptance(path, 'fsWrite', features.workspace, features.logging)
            assert.strictEqual(result.requiresAcceptance, true)
            assert.strictEqual(result.checkedTargets, undefined)
        }
    })

    it('fsRead collects one coherent target per input even after approval is required', async () => {
        const check = sinon.stub(shared, 'requiresPathAcceptance')
        check
            .onFirstCall()
            .resolves({ requiresAcceptance: true, warning: 'approval needed', checkedTargets: [checked('first')] })
        check.onSecondCall().resolves({ requiresAcceptance: false, checkedTargets: [checked('second')] })
        const result = await new FsRead(new TestFeatures()).requiresAcceptance({ paths: ['a', 'b'] })
        assert.deepStrictEqual(result, {
            requiresAcceptance: true,
            warning: 'approval needed',
            canonicalPaths: ['first', 'second'],
            checkedTargets: [checked('first'), checked('second')],
        })
        sinon.assert.calledTwice(check)
    })

    it('fsRead provides no executable targets if any input cannot be checked', async () => {
        sinon.stub(shared, 'requiresPathAcceptance').resolves({ requiresAcceptance: true })
        assert.strictEqual(
            (await new FsRead(new TestFeatures()).requiresAcceptance({ paths: ['unresolved'] })).checkedTargets,
            undefined
        )
    })

    it('fsRead uses supplied identities while keeping requested aliases in results', async () => {
        const read = sinon.stub(checkedIo, 'readCheckedFile').resolves('fixture')
        const targets = [checked('checked-a'), checked('checked-b')]
        const result = await new FsRead(new TestFeatures()).invoke({ paths: ['alias-a', 'alias-b'] }, targets)
        assert.deepStrictEqual(
            read.getCalls().map(c => c.args[1]),
            targets
        )
        assert.deepStrictEqual(result.output.content, [
            { path: 'alias-a', content: 'fixture', truncated: false },
            { path: 'alias-b', content: 'fixture', truncated: false },
        ])
    })

    it('includes the failed requested path in a multi-file read error', async () => {
        const read = sinon.stub(checkedIo, 'readCheckedFile')
        read.onFirstCall().resolves('fixture')
        read.onSecondCall().rejects(new Error('Read failed'))
        await assert.rejects(
            new FsRead(new TestFeatures()).invoke({ paths: ['alias-a', 'alias-b'] }, [checked('a'), checked('b')]),
            /alias-b.*Read failed/
        )
    })

    it('fsReplace validates accepted existence without a new path lookup', async () => {
        const features = new TestFeatures()
        const update = sinon.stub(checkedIo, 'updateCheckedFile').resolves({ mayHaveChanged: true, complete: true })
        features.workspace.fs.exists = sinon.stub().rejects(new Error('Unexpected path lookup'))
        const target = checked('checked-target')
        const tool = new FsReplace(features)
        const input = { path: 'unresolved-alias', diffs: [{ oldStr: 'before', newStr: 'after' }] }
        await tool.validate(input, target)
        await tool.invoke(input, target)
        sinon.assert.notCalled(features.workspace.fs.exists as sinon.SinonStub)
        assert.strictEqual(update.firstCall.args[1], target)
        assert.strictEqual(update.firstCall.args[2]('before'), 'after')
    })

    it('directory tools retain the checked root', async () => {
        const features = new TestFeatures()
        const tree = sinon.stub(workspaceUtils, 'readDirectoryWithTreeOutput').resolves('fixture')
        const search = sinon.stub(workspaceUtils, 'readDirectoryRecursively').resolves([])
        await new ListDirectory(features).invoke({ path: 'alias' }, 'checked-directory')
        await new FileSearch(features).invoke({ path: 'alias', queryName: 'fixture' }, 'checked-directory')
        assert.strictEqual(tree.firstCall.args[1], 'checked-directory')
        assert.strictEqual(search.firstCall.args[1], 'checked-directory')
    })

    it('fsWrite append forwards the checked identity with its existing transform', async () => {
        const features = new TestFeatures()
        const update = sinon.stub(checkedIo, 'updateCheckedFile').resolves({ mayHaveChanged: true, complete: true })
        features.workspace.fs.exists = sinon.stub().rejects(new Error('Unexpected path lookup'))
        const tool = new FsWrite(features)
        const input = { path: 'alias', command: 'append' as const, fileText: 'after' }
        const target = checked('checked-target')
        await tool.validate(input, target)
        await tool.invoke(input, target)
        assert.strictEqual(update.firstCall.args[1], target)
        assert.strictEqual(update.firstCall.args[2]('before'), 'before\nafter')
        sinon.assert.notCalled(features.workspace.fs.exists as sinon.SinonStub)
    })
})
