import * as assert from 'assert'
import { FileUpdateError } from '@aws/language-server-runtimes/server-interface'
import {
    AgenticChatError,
    DirectoryNotFoundError,
    EmptyAppendContentError,
    EmptyDiffsError,
    EmptyPathError,
    FileExistsWithSameContentError,
    FileNotExistsError,
    FileOperationError,
    IsDirectoryError,
    MissingContentError,
    MultipleMatchesError,
    NoSpaceError,
    PermissionDeniedError,
    TextNotFoundError,
    TooManyOpenFilesError,
    createFileOperationError,
    getCustomerFacingErrorMessage,
    getModelFacingFileError,
    isThrottlingRelated,
} from './errors'

describe('errors', () => {
    describe('FileOperationError classes', () => {
        it('creates error classes with correct customer messages', () => {
            const directoryError = new DirectoryNotFoundError('ENOENT: no such file or directory')
            assert.strictEqual(directoryError.message, 'ENOENT: no such file or directory')
            assert.strictEqual(directoryError.customerMessage, 'The directory does not exist.')

            const permissionError = new PermissionDeniedError('EACCES: permission denied')
            assert.strictEqual(permissionError.customerMessage, 'Permission denied.')

            const emptyPathError = new EmptyPathError()
            assert.strictEqual(emptyPathError.message, 'Path must not be empty')
            assert.strictEqual(emptyPathError.customerMessage, 'The file path cannot be empty.')
        })
    })

    describe('createFileOperationError', () => {
        it('maps common file system errors', () => {
            const error1 = createFileOperationError(new Error('ENOENT: no such file or directory'))
            assert.ok(error1 instanceof FileOperationError)
            assert.strictEqual(error1.customerMessage, 'The file or directory does not exist.')

            const error2 = createFileOperationError(new Error('EACCES: permission denied'))
            assert.ok(error2 instanceof PermissionDeniedError)

            const error3 = createFileOperationError(new Error('EISDIR: is a directory'))
            assert.ok(error3 instanceof IsDirectoryError)

            const error4 = createFileOperationError(new Error('ENOSPC: no space left on device'))
            assert.ok(error4 instanceof NoSpaceError)

            const error5 = createFileOperationError(new Error('EMFILE: too many open files'))
            assert.ok(error5 instanceof TooManyOpenFilesError)
        })

        it('maps errno codes when the original message has no code prefix', () => {
            const cases = [
                ['ENOENT', 'The file or directory does not exist.'],
                ['EACCES', 'Permission denied.'],
                ['EPERM', 'Permission denied.'],
                ['EISDIR', 'The specified path is a directory, not a file.'],
                ['ENOSPC', 'No space left on device.'],
                ['EMFILE', 'Too many open files.'],
                ['ENFILE', 'Too many open files.'],
            ]
            for (const [code, message] of cases) {
                assert.strictEqual(
                    getCustomerFacingErrorMessage(Object.assign(new Error('Operation failed'), { code })),
                    message
                )
            }
        })

        it('maps fsWrite specific errors', () => {
            const error1 = createFileOperationError(new Error('Path must not be empty'))
            assert.ok(error1 instanceof EmptyPathError)

            const error2 = createFileOperationError(new Error('fileText must be provided for create command'))
            assert.ok(error2 instanceof MissingContentError)

            const error3 = createFileOperationError(new Error('The file already exists with the same content'))
            assert.ok(error3 instanceof FileExistsWithSameContentError)

            const error4 = createFileOperationError(new Error('Content to append must not be empty'))
            assert.ok(error4 instanceof EmptyAppendContentError)
        })

        it('maps fsReplace specific errors', () => {
            const error1 = createFileOperationError(new Error('Diffs must not be empty'))
            assert.ok(error1 instanceof EmptyDiffsError)

            const error2 = createFileOperationError(
                new Error('The provided path must exist in order to replace contents into it')
            )
            assert.ok(error2 instanceof FileNotExistsError)

            const error3 = createFileOperationError(new Error('No occurrences of "some text" were found'))
            assert.ok(error3 instanceof TextNotFoundError)

            const error4 = createFileOperationError(
                new Error('Multiple occurrences of "some text" were found when only 1 is expected')
            )
            assert.ok(error4 instanceof MultipleMatchesError)
        })

        it('returns generic FileOperationError for unknown errors', () => {
            const unknownError = new Error('Some unknown error occurred')
            const result = createFileOperationError(unknownError)
            assert.ok(result instanceof FileOperationError)
            assert.strictEqual(result.message, 'Some unknown error occurred')
            assert.strictEqual(result.customerMessage, 'Some unknown error occurred')
        })
    })

    describe('getCustomerFacingErrorMessage', () => {
        it('maps file-open and exclusive-create errors without claiming the target changed', () => {
            const loop = Object.assign(new Error('internal open details'), { code: 'ELOOP' })
            assert.strictEqual(
                getCustomerFacingErrorMessage(loop),
                'This file cannot be opened for the requested operation. Check the path and try again.'
            )
            assert.strictEqual(
                getCustomerFacingErrorMessage(new Error('EEXIST: internal destination')),
                'A file already exists at this destination. Review it before trying again.'
            )
        })
        it('returns customer message from FileOperationError', () => {
            const error = new EmptyPathError()
            assert.strictEqual(getCustomerFacingErrorMessage(error), 'The file path cannot be empty.')
        })

        it('creates and returns customer message from standard Error', () => {
            const error = new Error('ENOENT: no such file or directory')
            assert.strictEqual(getCustomerFacingErrorMessage(error), 'The file or directory does not exist.')
        })

        it('handles non-Error objects', () => {
            assert.strictEqual(getCustomerFacingErrorMessage('string error'), 'string error')
            assert.strictEqual(getCustomerFacingErrorMessage(null), 'null')
            assert.strictEqual(getCustomerFacingErrorMessage(undefined), 'undefined')
        })
    })

    describe('model filesystem diagnostics', () => {
        it('retains the requested path and failed multiline replacement without putting it in the UI', () => {
            const cause = new TextNotFoundError('first line\nsecond line')
            const error = new FileUpdateError(cause, { mayHaveChanged: false, complete: false })
            assert.strictEqual(getCustomerFacingErrorMessage(error), 'The text to replace was not found in the file.')
            const detail = getModelFacingFileError(error, { path: 'requested-alias' })
            assert.ok(detail.includes('requested-alias'))
            assert.ok(detail.includes('first line\nsecond line'))
            assert.ok(!detail.includes('already contain changes'))
        })

        it('warns the user and model when mutation may have occurred', () => {
            const error = new FileUpdateError(Object.assign(new Error('Disk full'), { code: 'ENOSPC' }), {
                mayHaveChanged: true,
                complete: false,
            })
            assert.ok(getCustomerFacingErrorMessage(error).includes('No space left on device.'))
            assert.ok(getCustomerFacingErrorMessage(error).includes('may already contain changes'))
            assert.ok(
                getModelFacingFileError(error, { path: 'requested-alias' }).includes('do not repeat the edit blindly')
            )
        })

        it('still warns when the error comes from a second copy of the runtime package', () => {
            // A duplicate install gives the runtime its own FileUpdateError class; the warning must not depend on instanceof.
            const modulePath = require.resolve('@aws/language-server-runtimes/server-interface/checkedFile')
            const cached = require.cache[modulePath]
            delete require.cache[modulePath]
            const duplicate: typeof import('@aws/language-server-runtimes/server-interface/checkedFile') = require('@aws/language-server-runtimes/server-interface/checkedFile')
            require.cache[modulePath] = cached
            assert.notStrictEqual(duplicate.FileUpdateError, FileUpdateError, 'test setup must load a second copy')
            const error = new duplicate.FileUpdateError(Object.assign(new Error('Disk full'), { code: 'ENOSPC' }), {
                mayHaveChanged: true,
                complete: false,
            })
            assert.strictEqual(error instanceof FileUpdateError, false)
            assert.ok(getCustomerFacingErrorMessage(error).includes('may already contain changes'))
            assert.ok(
                getModelFacingFileError(error, { path: 'requested-alias' }).includes('do not repeat the edit blindly')
            )
        })

        it('maps changed and unsupported file targets to actionable UI messages', () => {
            for (const code of ['ESTALE', 'ENXIO', 'EINVAL']) {
                assert.notStrictEqual(
                    getCustomerFacingErrorMessage(Object.assign(new Error('internal detail'), { code })),
                    'internal detail'
                )
            }
        })
    })

    describe('isThrottlingRelated', () => {
        it('should return true for AgenticChatError with RequestThrottled code', () => {
            const error = new AgenticChatError('Request was throttled', 'RequestThrottled')
            assert.strictEqual(isThrottlingRelated(error), true)
        })

        it('should return true for ServiceUnavailableException', () => {
            const error = new Error('Service Unavailable')
            error.name = 'ServiceUnavailableException'
            assert.strictEqual(isThrottlingRelated(error), true)
        })

        it('should return false for other errors', () => {
            const error = new Error('Some other error')
            assert.strictEqual(isThrottlingRelated(error), false)
            assert.strictEqual(isThrottlingRelated('not an error'), false)
            assert.strictEqual(isThrottlingRelated(null), false)
        })
    })
})
