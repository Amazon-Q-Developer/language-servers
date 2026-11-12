/**
 * Shared image verification utilities for AWS LSP packages
 * Provides consistent image validation across client and server components
 * This is a server-side version that works with Node.js Buffer objects
 */

import imageSize from 'image-size'

/** Image formats that can be sent, as read from the image content */
export type SupportedImageFormat = 'jpeg' | 'png' | 'gif' | 'webp'

export interface ImageVerificationResult {
    isValid: boolean
    errors: string[]
    /** Format read from the image content, for a valid image */
    format?: SupportedImageFormat
}

export const MAX_IMAGE_CONTEXT_COUNT = 20

export interface ImageVerificationOptions {
    maxSizeBytes?: number
    maxDimension?: number
    supportedExtensions?: string[]
}

export const DEFAULT_IMAGE_VERIFICATION_OPTIONS: Required<ImageVerificationOptions> = {
    maxSizeBytes: 3.75 * 1024 * 1024, // 3.75MB
    maxDimension: 8000, // 8000px
    supportedExtensions: ['jpeg', 'jpg', 'png', 'gif', 'webp'],
}

/**
 * Verifies if a file extension is supported for images
 */
export function isSupportedImageExtension(extension: string): boolean {
    const ext = extension.toLowerCase().replace('.', '')
    return DEFAULT_IMAGE_VERIFICATION_OPTIONS.supportedExtensions.includes(ext)
}

/**
 * Verifies if a file size is within acceptable limits
 */
export function isFileSizeValid(fileSize: number, maxSizeBytes?: number): boolean {
    const maxSize = maxSizeBytes ?? DEFAULT_IMAGE_VERIFICATION_OPTIONS.maxSizeBytes
    return fileSize <= maxSize
}

/**
 * Verifies if image dimensions are within acceptable limits
 */
export function areImageDimensionsValid(width: number, height: number, maxDimension?: number): boolean {
    const maxDim = maxDimension ?? DEFAULT_IMAGE_VERIFICATION_OPTIONS.maxDimension
    return width <= maxDim && height <= maxDim
}

/**
 * Server-side image verification for file paths and buffers (Node.js environment)
 */
export async function verifyServerImage(
    fileName: string,
    fileSize: number,
    imageBuffer: Buffer
): Promise<ImageVerificationResult> {
    const opts = DEFAULT_IMAGE_VERIFICATION_OPTIONS
    const errors: string[] = []

    // Check file extension
    const extension = fileName.split('.').pop()?.toLowerCase() || ''
    if (!isSupportedImageExtension(extension)) {
        errors.push(`${fileName}: File must be an image in JPEG, PNG, GIF, or WebP format.`)
        return { isValid: false, errors }
    }

    // Check file size
    if (!isFileSizeValid(fileSize, opts.maxSizeBytes)) {
        errors.push(
            `${fileName}: Image must be no more than ${(opts.maxSizeBytes / (1024 * 1024)).toFixed(2)}MB in size.`
        )
        return { isValid: false, errors }
    }

    // Check the image content: its format and dimensions
    let image: { width: number; height: number; format: string }
    try {
        image = getServerImageDimensions(imageBuffer)
    } catch (error) {
        errors.push(`${fileName}: Unable to read image dimensions.`)
        return { isValid: false, errors }
    }
    if (!isSupportedImageExtension(image.format)) {
        errors.push(`${fileName}: File must be an image in JPEG, PNG, GIF, or WebP format.`)
        return { isValid: false, errors }
    }
    if (!areImageDimensionsValid(image.width, image.height, opts.maxDimension)) {
        errors.push(`${fileName}: Image must be no more than ${opts.maxDimension}px in width or height.`)
        return { isValid: false, errors }
    }

    const format = (image.format === 'jpg' ? 'jpeg' : image.format) as SupportedImageFormat
    return { isValid: true, errors: [], format }
}

/**
 * The format and dimensions of an image, read from its content. Throws when the content is not an image whose
 * format and dimensions can be read.
 */
function getServerImageDimensions(buffer: Buffer): { width: number; height: number; format: string } {
    const dimensions = imageSize(buffer)
    if (!dimensions.type || !dimensions.width || !dimensions.height) {
        throw new Error('Unable to read image dimensions')
    }
    return {
        width: dimensions.width,
        height: dimensions.height,
        format: dimensions.type.toLowerCase(),
    }
}
