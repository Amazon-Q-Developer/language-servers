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
 * Remembers, per job id, whether the job has generate_integration_tests: true. createJob records the flag it
 * sent; a job this LS didn't create (resume, job history, beam) is read once from its objective. Entries are
 * dropped when the job ends, and the map is capped so a long session can't grow it without bound.
 */
export class ItGenJobGate {
    static readonly maxJobs = 200

    private readonly jobs = new Map<string, boolean>()

    constructor(
        private readonly readObjective: ReadJobObjective,
        private readonly log: (message: string) => void
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
        this.jobs.delete(jobId)
        this.jobs.set(jobId, itGen)
        while (this.jobs.size > ItGenJobGate.maxJobs) {
            const oldest = this.jobs.keys().next().value
            if (oldest === undefined) {
                break
            }
            this.jobs.delete(oldest)
        }
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

    forget(jobId: string): void {
        this.jobs.delete(jobId)
    }
}
