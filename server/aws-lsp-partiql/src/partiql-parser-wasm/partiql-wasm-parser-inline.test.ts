import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import * as path from 'path'
import binary from './partiql-wasm-parser-inline'

describe('PartiQL parser binary', () => {
    it('is a WebAssembly module', () => {
        expect(Array.from(binary.subarray(0, 4))).toEqual([0x00, 0x61, 0x73, 0x6d])
    })

    it('matches the SHA-256 that is recorded next to it', () => {
        const recorded = readFileSync(path.join(__dirname, 'partiql_playground_bg.wasm.sha256'), 'utf-8')
        const [sha256, fileName] = recorded.trim().split(/\s+/)

        expect(fileName).toBe('partiql_playground_bg.wasm')
        expect(createHash('sha256').update(binary).digest('hex')).toBe(sha256)
    })
})
