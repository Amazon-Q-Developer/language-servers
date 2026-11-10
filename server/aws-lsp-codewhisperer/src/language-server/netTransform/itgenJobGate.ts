// ITGen (integration test generation) job gate: the LS runs its ITGen code only for jobs whose objective has
// generate_integration_tests: true. Every other job behaves exactly as before ITGen.

export const ATX_OBJECTIVE_GENERATE_INTEGRATION_TESTS_KEY = 'generate_integration_tests'

/** True when a job's objective (the JSON string CreateJob sent) has generate_integration_tests: true. */
export function objectiveHasIntegrationTests(objective: string | undefined): boolean {
    if (!objective) {
        return false
    }
    try {
        return JSON.parse(objective)?.[ATX_OBJECTIVE_GENERATE_INTEGRATION_TESTS_KEY] === true
    } catch {
        return false
    }
}

/** Reads a job's objective; null when the job can't be read. */
export type ReadJobObjective = (workspaceId: string, jobId: string) => Promise<{ objective?: string } | null>

/**
 * Reads a job's beam-map: true when any beamed repo has generateIntegrationTests: true, false when none does,
 * 'unconfirmed' when the scan finished without a beam-map but couldn't read every candidate that could be one (it
 * couldn't be downloaded, or was past the scan's candidate cap), and undefined when the beam-map wasn't read (for
 * example while FES throttles us).
 */
export type ReadBeamOptIn = (workspaceId: string, jobId: string) => Promise<boolean | 'unconfirmed' | undefined>

/**
 * Remembers, per job id, whether the job has generate_integration_tests: true. createJob records the flag it
 * sent; a job this LS didn't create (resume, job history, beam) is read once from its objective. Entries are
 * dropped when the job ends, and the map is capped so a long session can't grow it without bound.
 */
export class ItGenJobGate {
    static readonly maxJobs = 200
    /**
     * How long after a beam-map read that couldn't tell (or is still running) the next read may start. It doubles
     * with each 'unconfirmed' read in a row, and after beamMaxReadsThatCannotTell of them the answer is "no" for
     * the session: each read is a full beam-map scan, and a beam-map the IDE can't download (one the service only
     * publishes for a job that opts in) never becomes downloadable. A read that didn't happen (throttled, cut short,
     * failed) is retried at the same pace and doesn't count.
     */
    static readonly beamRetryMs = 60_000
    static readonly beamMaxReadsThatCannotTell = 5

    private readonly jobs = new Map<string, boolean>()
    // Beamed jobs without a known opt-in: the time their beam-map may be read again.
    private readonly beamChecks = new Map<string, number>()
    // Beamed jobs: how many reads in a row couldn't tell.
    private readonly beamRetries = new Map<string, number>()

    constructor(
        private readonly readObjective: ReadJobObjective,
        private readonly log: (message: string) => void,
        private readonly readBeamOptIn?: ReadBeamOptIn,
        private readonly now: () => number = Date.now
    ) {}

    /** Whether the job is known (either way), so its objective doesn't need to be read again. */
    isKnown(jobId: string): boolean {
        return this.jobs.has(jobId)
    }

    /** True only for a job already known to have generate_integration_tests: true. Never reads the job. */
    isKnownItGenJob(jobId: string): boolean {
        return this.jobs.get(jobId) === true
    }

    rememberFlag(jobId: string, itGen: boolean): void {
        ItGenJobGate.setCapped(this.jobs, jobId, itGen)
    }

    /** A beamed repo of this job (the parent web job) opts in through its beam-map entry. */
    rememberBeamOptIn(jobId: string): void {
        if (!this.isKnownItGenJob(jobId)) {
            this.log(`ATX: job ${jobId} has a beamed repo with generateIntegrationTests`)
        }
        this.rememberFlag(jobId, true)
        this.beamChecks.delete(jobId)
        this.beamRetries.delete(jobId)
    }

    rememberObjective(jobId: string, objective: string | undefined): boolean {
        const itGen = objectiveHasIntegrationTests(objective)
        this.rememberFlag(jobId, itGen)
        this.log(`ATX: job ${jobId} ${itGen ? 'has' : "doesn't have"} generate_integration_tests`)
        return itGen
    }

    /** Reads the job's objective the first time; a failed read isn't remembered, so the next call asks again. */
    async isItGenJob(workspaceId: string, jobId: string): Promise<boolean> {
        const known = this.jobs.get(jobId)
        if (known !== undefined) {
            return known
        }
        const job = await this.readObjective(workspaceId, jobId)
        if (!job) {
            return false
        }
        return this.rememberObjective(jobId, job.objective)
    }

    /**
     * For a beamed repo, whose job is the parent web job: its objective never opts in, its beam-map entries do. When
     * neither the objective nor an earlier read says yes, reads the beam-map. A beam-map without an opt-in isn't read
     * again until the job is forgotten: the beam-map is written when a repo is beamed, before the IDE loads it, and a
     * repo beamed later is picked up by the dashboard's discovery (listBeamedRepos calls rememberBeamOptIn). A read
     * that couldn't tell is retried after beamRetryMs, doubling with each 'unconfirmed' read, and after
     * beamMaxReadsThatCannotTell of those the answer is "no". With `waitForBeamMap` false (a poll) the read runs in the
     * background and the gate turns on from the next call.
     */
    async isBeamItGenJob(workspaceId: string, jobId: string, waitForBeamMap = true): Promise<boolean> {
        if (await this.isItGenJob(workspaceId, jobId)) {
            return true
        }
        // A background read can record the opt-in while isItGenJob is awaited: check again before reading.
        if (this.isKnownItGenJob(jobId)) {
            return true
        }
        const nextCheck = this.beamChecks.get(jobId)
        if (!this.readBeamOptIn || (nextCheck !== undefined && this.now() < nextCheck)) {
            return false
        }
        // Set before the read starts, so calls while it runs don't start another one. It's also the next check
        // when this read can't tell.
        const retries = this.beamRetries.get(jobId) ?? 0
        ItGenJobGate.setCapped(this.beamChecks, jobId, this.now() + ItGenJobGate.beamRetryMs * 2 ** retries)
        const unconfirmed = () => {
            if (retries + 1 < ItGenJobGate.beamMaxReadsThatCannotTell) {
                ItGenJobGate.setCapped(this.beamRetries, jobId, retries + 1)
                return
            }
            this.log(
                `ATX: job ${jobId}: ${ItGenJobGate.beamMaxReadsThatCannotTell} beam-map reads couldn't tell ` +
                    `whether a beamed repo opts in to ITGen; treating it as not opted in this session`
            )
            ItGenJobGate.setCapped(this.beamChecks, jobId, Number.POSITIVE_INFINITY)
            this.beamRetries.delete(jobId)
        }
        const read = this.readBeamOptIn(workspaceId, jobId).then(
            optIn => {
                if (optIn === true) {
                    this.rememberBeamOptIn(jobId)
                } else if (optIn === false) {
                    ItGenJobGate.setCapped(this.beamChecks, jobId, Number.POSITIVE_INFINITY)
                    this.beamRetries.delete(jobId)
                } else if (optIn === 'unconfirmed') {
                    unconfirmed()
                }
            },
            error => this.log(`ATX: couldn't read the beam-map of job ${jobId}: ${String(error)}`)
        )
        if (!waitForBeamMap) {
            return false
        }
        await read
        return this.isKnownItGenJob(jobId)
    }

    forget(jobId: string): void {
        this.jobs.delete(jobId)
        this.beamChecks.delete(jobId)
        this.beamRetries.delete(jobId)
    }

    // Insert as the newest entry; drop the oldest beyond maxJobs.
    private static setCapped<T>(map: Map<string, T>, jobId: string, value: T): void {
        map.delete(jobId)
        map.set(jobId, value)
        while (map.size > ItGenJobGate.maxJobs) {
            const oldest = map.keys().next().value
            if (oldest === undefined) {
                break
            }
            map.delete(oldest)
        }
    }
}
