import { expect } from 'chai'
import * as sinon from 'sinon'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { beamApplyStepIds, isLocalBuildVerificationStep, listBeamRepoFiles, PlanNode } from '../beamRepoFiles'

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

        // The handler finds LBV nodes the same way (findAllLbvNodes), so a re-beamed or renamed LBV is still left out.
        it('leaves out an LBV step whatever its casing or suffix, with its rounds', () => {
            const renamed: PlanNode = {
                StepId: 'root',
                Children: [
                    {
                        StepId: 'repo',
                        Children: [
                            {
                                StepId: 'lbv-2',
                                StepName: 'local build verification (attempt 2)',
                                Children: [{ StepId: 'round-1' }],
                            },
                            { StepId: 'fix-1', StepName: 'Fixing code · iteration 1' },
                        ],
                    },
                ],
            }

            expect([...beamApplyStepIds(renamed, new Set(['repo', 'lbv-2', 'round-1', 'fix-1']))]).to.deep.equal([
                'fix-1',
            ])
        })
    })

    describe('isLocalBuildVerificationStep', () => {
        for (const name of ['Local Build Verification', 'LOCAL BUILD VERIFICATION', 'Local Build Verification 2']) {
            it(`is true for ${JSON.stringify(name)}`, () => {
                expect(isLocalBuildVerificationStep(name)).to.be.true
            })
        }
        for (const name of ['Local Verification', 'Build', '', undefined]) {
            it(`is false for ${JSON.stringify(name)}`, () => {
                expect(isLocalBuildVerificationStep(name)).to.be.false
            })
        }
    })

    describe('listBeamRepoFiles', () => {
        let root: string
        const write = (rel: string, content = '') => {
            fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
            fs.writeFileSync(path.join(root, rel), content)
        }
        const listed = async (max?: number) =>
            (await listBeamRepoFiles(root, 'artifactWorkspace', max)).files.map(f =>
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

        it('stops at the file cap, and says so', async () => {
            for (let i = 0; i < 5; i++) {
                write(`f${i}.cs`)
            }

            const result = await listBeamRepoFiles(root, 'artifactWorkspace', 3)

            expect(result.files).to.have.length(3)
            expect(result.truncated).to.be.true
            expect((await listBeamRepoFiles(root, 'artifactWorkspace', 5)).truncated).to.be.false
        })

        it('leaves out a folder it cannot read, and lists the rest', async () => {
            write('Web/Program.cs')
            write('Locked/Secret.cs')
            write('Api/Api.cs')
            const readdir = fs.promises.readdir
            sinon
                .stub(fs.promises, 'readdir')
                .callsFake(((dir: fs.PathLike, options: any) =>
                    path.basename(String(dir)) === 'Locked'
                        ? Promise.reject(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
                        : readdir(dir, options)) as any)

            const result = await listBeamRepoFiles(root, 'artifactWorkspace')

            expect(result.files.map(f => path.relative(root, f).split(path.sep).join('/')).sort()).to.deep.equal([
                'Api/Api.cs',
                'Web/Program.cs',
            ])
            expect(result.unreadableFolders).to.deep.equal(['Locked'])
        })

        it('fails when the root itself cannot be read', async () => {
            const missing = path.join(root, 'missing')

            let error: unknown
            try {
                await listBeamRepoFiles(missing, 'artifactWorkspace')
            } catch (e) {
                error = e
            }
            expect(error).to.be.an('error')
        })
    })
})
