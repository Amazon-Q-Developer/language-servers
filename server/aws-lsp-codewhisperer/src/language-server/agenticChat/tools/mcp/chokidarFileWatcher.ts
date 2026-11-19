import { watch, FSWatcher } from 'chokidar'
import { Logging } from '@aws/language-server-runtimes/server-interface'
import { normalizePathFromUri } from './mcpUtils'

export class ChokidarFileWatcher {
    private watcher: FSWatcher | null = null
    private logger: Logging

    constructor(logger: Logging) {
        this.logger = logger
    }

    watchPaths(paths: string[], callback: (changedPath: string) => void, options?: { includeUnlink?: boolean }): void {
        if (this.watcher) {
            this.close()
        }

        const normalizedPaths = paths.map(path => normalizePathFromUri(path, this.logger))

        this.watcher = watch(normalizedPaths, {
            ignoreInitial: true,
            persistent: true,
            awaitWriteFinish: {
                stabilityThreshold: 300,
                pollInterval: 100,
            },
        })

        this.watcher.on('add', path => {
            this.logger.info(`MCP config file created: ${path}`)
            callback(path)
        })

        this.watcher.on('change', path => {
            this.logger.info(`MCP config file changed: ${path}`)
            callback(path)
        })

        if (options?.includeUnlink) {
            this.watcher.on('unlink', path => {
                this.logger.info(`Watched file removed: ${path}`)
                callback(path)
            })
        }

        this.watcher.on('error', error => {
            this.logger.warn(`File watcher error: ${error instanceof Error ? error.message : String(error)}`)
        })

        this.logger.info(`Watching ${normalizedPaths.length} MCP config paths with chokidar`)
    }

    close(): void {
        if (this.watcher) {
            void this.watcher.close()
            this.watcher = null
            this.logger.info('Closed chokidar file watcher')
        }
    }
}
