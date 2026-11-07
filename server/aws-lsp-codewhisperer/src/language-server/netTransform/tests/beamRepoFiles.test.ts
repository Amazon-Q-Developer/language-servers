import { expect } from 'chai'
import * as sinon from 'sinon'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { beamApplyStepIds, listBeamRepoFiles, PlanNode } from '../beamRepoFiles'

describe('beamRepoFiles', () => {
    afterEach(() => {
        sinon.restore()
    })

    describe('beamApplyStepIds', () => {
        // A pre-beam step, then the beamed repo's card: unit tests, and Local Verification with LBV (and a round),
        // a code fix and adding the tests. A sibling beamed repo's card next to it.
        const plan: PlanNode = {
            StepId: 'root',
            Children: [
                { StepId: 'pre', StepName: 'Transform App' },
                {
                    StepId: 'repo',
                    StepName: 'App (beamed)',
                    Children: [
                        { StepId: 'ut', StepName: 'Generate unit tests' },
                        {
                            StepId: 'lv',
                            StepName: 'Local Verification',
                            Children: [
                                {
                                    StepId: 'lbv',
                                    StepName: 'Local Build Verification',
                                    Children: [{ StepId: 'round-1', StepName: 'Round 1' }],
                                },
                                { StepId: 'fix-1', StepName: 'Fixing code · iteration 1' },
                                { StepId: 'add', StepName: 'Adding tests to your solution' },
                            ],
                        },
                    ],
                },
                { StepId: 'sibling', StepName: 'Other (beamed)', Children: [{ StepId: 'sibling-ut' }] },
            ],
        }
        const scope = new Set(['repo', 'ut', 'lv', 'lbv', 'round-1', 'fix-1', 'add'])

        it("keeps the steps under the repo's card, without the card itself and LBV with its rounds", () => {
            expect([...beamApplyStepIds(plan, scope)].sort()).to.deep.equal(['add', 'fix-1', 'lv', 'ut'])
        })

        it('keeps nothing outside the scope: pre-beam steps and sibling repos', () => {
            const ids = beamApplyStepIds(plan, scope)
            for (const id of ['pre', 'sibling', 'sibling-ut']) {
                expect(ids.has(id), id).to.be.false
            }
        })

        it('keeps nothing for an empty scope', () => {
            expect(beamApplyStepIds(plan, new Set()).size).to.equal(0)
        })
    })

    describe('listBeamRepoFiles', () => {
        let root: string
        const write = (rel: string, content = '') => {
            fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
            fs.writeFileSync(path.join(root, rel), content)
        }
        const listed = async (max?: number) =>
            (await listBeamRepoFiles(root, 'artifactWorkspace', max)).map(f =>
                path.relative(root, f).split(path.sep).join('/')
            )

        beforeEach(() => {
            root = fs.mkdtempSync(path.join(os.tmpdir(), 'atx-beam-files-'))
        })

        afterEach(() => {
            fs.rmSync(root, { recursive: true, force: true })
        })

        it('lists source files, without build output, VCS and IDE folders, and artifactWorkspace', async () => {
            write('App.sln')
            write('Web/Program.cs')
            write('Web/bin/Debug/Web.dll')
            write('Web/obj/project.assets.json')
            write('.git/HEAD')
            write('.vs/App/v17/.suo')
            write('ArtifactWorkspace/job-1/checkpoints/source-files.json')

            expect((await listed()).sort()).to.deep.equal(['App.sln', 'Web/Program.cs'])
        })

        it('skips a NuGet packages folder but lists a source folder named packages', async () => {
            write('packages/Newtonsoft.Json.13.0.1/Newtonsoft.Json.13.0.1.nupkg')
            write('src/packages/Shared/Shared.cs')

            expect(await listed()).to.deep.equal(['src/packages/Shared/Shared.cs'])
        })

        it('stops at the file cap', async () => {
            for (let i = 0; i < 5; i++) {
                write(`f${i}.cs`)
            }

            expect(await listed(3)).to.have.length(3)
        })
    })
})
