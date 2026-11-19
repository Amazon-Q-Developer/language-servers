import { Features } from '@aws/language-server-runtimes/server-interface/server'
import { createCheckedFileOperations } from '@aws/language-server-runtimes/testing'
import { captureCheckedTarget } from './checkedFileIo'
import { resolveCanonicalPath } from './toolShared'

/** Use the public runtime testing seam without mutating the provider shared by other fixtures. */
export function withCheckedFileOperations(filesystem: Features['workspace']['fs']): Features['workspace']['fs'] {
    const operations = createCheckedFileOperations()
    return { ...filesystem, checkedFiles: operations ? { ...operations } : undefined }
}

export async function checkedTarget(path: string) {
    const workspace = { fs: { checkedFiles: createCheckedFileOperations() } } as Features['workspace']
    return captureCheckedTarget(workspace, await resolveCanonicalPath(path))
}
