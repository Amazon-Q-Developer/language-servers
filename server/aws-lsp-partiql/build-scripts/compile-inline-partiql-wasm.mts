import { createHash } from 'crypto'
import { $, fs, os, path } from 'zx'

// Updates the PartiQL parser binary and its bindings in src/partiql-parser-wasm from a release of
// https://github.com/partiql/partiql-rust-playground, and records the SHA-256 of the binary next to it.
//
// The release archive must match PLAYGROUND_ARCHIVE_SHA256 before any file in it is used. The PartiQL team
// builds the archive from the tagged commit with a pinned toolchain and Cargo.lock (scripts/package-web.sh
// in that repository), so it can be rebuilt from source to check it. To use another release, check its
// .sha256 file and its build-info.json, then change both values below.
const PLAYGROUND_VERSION = '0.3.0'
const PLAYGROUND_ARCHIVE_SHA256 = '0aedd0df190d218aac9e10469daceea17ef7330dae44ddcd933b1c368205fee8'

const name = `partiql-playground-web-${PLAYGROUND_VERSION}`
const url = `https://github.com/partiql/partiql-rust-playground/releases/download/v${PLAYGROUND_VERSION}/${name}.tar.gz`
const outputFolder = 'src/partiql-parser-wasm'

const response = await fetch(url)
if (!response.ok) {
    throw new Error(`Download of ${url} failed: HTTP ${response.status}`)
}
const archive = Buffer.from(await response.arrayBuffer())
const archiveSha256 = createHash('sha256').update(archive).digest('hex')
if (archiveSha256 !== PLAYGROUND_ARCHIVE_SHA256) {
    throw new Error(`${name}.tar.gz has SHA-256 ${archiveSha256}, but ${PLAYGROUND_ARCHIVE_SHA256} was expected`)
}

const workFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'partiql-wasm-'))
try {
    const archivePath = path.join(workFolder, `${name}.tar.gz`)
    await fs.writeFile(archivePath, archive)
    await $`tar -xzf ${archivePath} -C ${workFolder}`
    const release = path.join(workFolder, name)

    // Encode the binary in a .ts file, with the license and notice of the release and a description of our
    // modifications.
    const binary = await fs.readFile(path.join(release, 'partiql_playground_bg.wasm'))
    const license = await fs.readFile(path.join(release, 'LICENSE'), 'utf-8')
    const notice = await fs.readFile(path.join(release, 'NOTICE'), 'utf-8')
    const modifications =
        '`base64EncodedBinary` contains a base64 encoding of the Rust PartiQL parser compiled to WebAssembly.\n\tModifications around it are to import it from a JS/TS file and instantiate it using `WebAssembly.instantiate.`'
    const encodedPartiQLServer = `/*\n${license}\n\n\t${notice}\n\n\t${modifications}\n*/\n\nconst base64String = atob("${binary.toString('base64')}");\nconst base64Buffer = new Uint8Array(base64String.length);\nfor (var i = 0; i < base64String.length; i++) base64Buffer[i] = base64String.charCodeAt(i);\nexport default base64Buffer;`
    await fs.writeFile(path.join(outputFolder, 'partiql-wasm-parser-inline.ts'), encodedPartiQLServer)

    for (const file of ['partiql_playground.js', 'partiql_playground.d.ts']) {
        await fs.copyFile(path.join(release, file), path.join(outputFolder, file))
    }

    const binarySha256 = createHash('sha256').update(binary).digest('hex')
    await fs.writeFile(
        path.join(outputFolder, 'partiql_playground_bg.wasm.sha256'),
        `${binarySha256}  partiql_playground_bg.wasm\n`
    )
    console.log(`Updated the PartiQL parser from ${name}. SHA-256 of the binary: ${binarySha256}`)
} finally {
    await fs.remove(workFolder)
}
