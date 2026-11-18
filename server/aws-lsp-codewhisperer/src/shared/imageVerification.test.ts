import * as assert from 'assert'
import { DEFAULT_IMAGE_VERIFICATION_OPTIONS, verifyServerImage } from './imageVerification'

// Smallest headers that image-size reads the format and dimensions from
function png(width: number, height: number): Buffer {
    const image = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(image, 0)
    image.writeUInt32BE(13, 8)
    image.write('IHDR', 12, 'ascii')
    image.writeUInt32BE(width, 16)
    image.writeUInt32BE(height, 20)
    return image
}

function gif(width: number, height: number): Buffer {
    const image = Buffer.alloc(16)
    image.write('GIF89a', 0, 'ascii')
    image.writeUInt16LE(width, 6)
    image.writeUInt16LE(height, 8)
    return image
}

function bmp(width: number, height: number): Buffer {
    const image = Buffer.alloc(32)
    image.write('BM', 0, 'ascii')
    image.writeInt32LE(width, 18)
    image.writeInt32LE(height, 22)
    return image
}

describe('verifyServerImage', () => {
    const { maxDimension, maxSizeBytes } = DEFAULT_IMAGE_VERIFICATION_OPTIONS

    it('accepts a PNG image and reports its format', async () => {
        const image = png(10, 20)

        assert.deepStrictEqual(await verifyServerImage('a.png', image.length, image), {
            isValid: true,
            errors: [],
            format: 'png',
        })
    })

    it('accepts a GIF image and reports its format', async () => {
        const image = gif(10, 20)

        const result = await verifyServerImage('a.gif', image.length, image)

        assert.strictEqual(result.isValid, true)
        assert.strictEqual(result.format, 'gif')
    })

    it('reports the format read from the content, not from the file name', async () => {
        const image = png(10, 20)

        const result = await verifyServerImage('photo.jpg', image.length, image)

        assert.strictEqual(result.isValid, true)
        assert.strictEqual(result.format, 'png')
    })

    it('rejects content that is not an image', async () => {
        for (const content of [Buffer.from('not an image'), Buffer.alloc(0)]) {
            const result = await verifyServerImage('a.png', content.length, content)

            assert.strictEqual(result.isValid, false)
            assert.deepStrictEqual(result.errors, ['a.png: Unable to read image dimensions.'])
            assert.strictEqual(result.format, undefined)
        }
    })

    it('rejects an image in a format that is not supported', async () => {
        const image = bmp(10, 20)

        const result = await verifyServerImage('a.png', image.length, image)

        assert.strictEqual(result.isValid, false)
        assert.deepStrictEqual(result.errors, ['a.png: File must be an image in JPEG, PNG, GIF, or WebP format.'])
    })

    it('rejects an image with no width or height', async () => {
        for (const image of [png(0, 20), png(10, 0)]) {
            const result = await verifyServerImage('a.png', image.length, image)

            assert.strictEqual(result.isValid, false)
            assert.deepStrictEqual(result.errors, ['a.png: Unable to read image dimensions.'])
        }
    })

    it('accepts an image at the dimension limit and rejects a larger one', async () => {
        const atLimit = png(maxDimension, maxDimension)
        const tooWide = png(maxDimension + 1, 10)

        assert.strictEqual((await verifyServerImage('a.png', atLimit.length, atLimit)).isValid, true)
        const result = await verifyServerImage('a.png', tooWide.length, tooWide)
        assert.strictEqual(result.isValid, false)
        assert.deepStrictEqual(result.errors, [
            `a.png: Image must be no more than ${maxDimension}px in width or height.`,
        ])
    })

    it('rejects a file over the size limit', async () => {
        const result = await verifyServerImage('a.png', maxSizeBytes + 1, png(10, 20))

        assert.strictEqual(result.isValid, false)
        assert.strictEqual(result.errors.length, 1)
        assert.ok(result.errors[0].includes('in size'))
    })

    it('rejects a file name without a supported image extension', async () => {
        const image = png(10, 20)

        const result = await verifyServerImage('a.txt', image.length, image)

        assert.strictEqual(result.isValid, false)
        assert.deepStrictEqual(result.errors, ['a.txt: File must be an image in JPEG, PNG, GIF, or WebP format.'])
    })
})
