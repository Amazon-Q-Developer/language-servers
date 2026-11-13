import { ParsedIniData, IniSectionType, IniSection } from '@smithy/types'
import * as fs from 'fs'
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'fs/promises'
import { EOL } from 'os'
import { IniFileType, Setting, SectionHeader } from './types'
import { CONFIG_PREFIX_SEPARATOR } from '@smithy/shared-ini-file-loader'
import path from 'path'

const sectionHeaderKey = '#sectionHeader'
const nextSettingKey = '#nextSetting'

// Modes for newly created shared config files and directories
const newFileMode = 0o600
const newDirectoryMode = 0o700

export async function saveSharedConfigFile(
    filepath: string,
    filetype: IniFileType,
    file: ParsedIniData
): Promise<void> {
    const output: string[] = []
    const filepathExists = fs.existsSync(filepath)

    if (filepathExists) {
        // Be tolerant of line terminator in file regardless of OS
        const input = (await readFile(filepath, { encoding: 'utf-8' })).split(/\r?\n/)

        for (let it = new IniFileIterator(input.values(), output), { done, value } = it.nextSectionHeader(); !done; ) {
            if (!value) {
                continue
            }

            // Write updated section
            const parsedSectionName = value.toParsedSectionName()
            const newSettingsIndices: Record<string, number> = {}
            if (file[parsedSectionName] && Object.keys(file[parsedSectionName]).length > 0) {
                const fileSection = file[parsedSectionName]
                newSettingsIndices[sectionHeaderKey] = output.push(value.toIniSectionName(filetype))

                // Remove/update settings in file based on in-memory section
                ;({ done, value } = it.nextSectionHeader((setting: Setting) => {
                    const parsedSettingName = setting.toParsedSettingName()

                    // If setting in file, but not in-memory then skip it (it's been deleted)
                    if (!fileSection[parsedSettingName]) {
                        return
                    }

                    // Otherwise, update setting in file regardless
                    setting.value = fileSection[parsedSettingName]

                    // Done with this setting, delete so that only new settings are left at the end of the loop
                    // This also prevents writing redundant settings in the same section
                    delete fileSection[parsedSettingName]

                    if (setting.subsection && !newSettingsIndices[setting.subsection]) {
                        newSettingsIndices[setting.subsection] = output.push(setting.toIniSubsectionHeaderLine())
                    }

                    newSettingsIndices[nextSettingKey] = output.push(setting.toIniSettingLine())
                }))

                // Insert remaining settings (i.e. new settings) after last setting written or under section header
                // to avoid splitting settings across commented out sections at the end (which may be a commented out section itself)
                outputNewSettings(fileSection, newSettingsIndices, output)
            } else {
                // Delete no longer existing section by not emitting anything until the next section header is read
                // eslint-disable-next-line no-extra-semi
                ;({ done, value } = it.nextSectionHeader())
            }

            // Delete processed sections from file so only new sections in file are left at the end of this loop
            delete file[parsedSectionName]
        }
    }

    // Add remaining sections (i.e. new sections) to the end of the file
    for (const [parsedSectionName, parsedSectionSettings] of Object.entries(file).sort(compareObjectEntries)) {
        if (parsedSectionName && parsedSectionSettings && Object.keys(parsedSectionSettings).length > 0) {
            const newSettingsIndices: Record<string, number> = {}

            output.push('') // Empty line
            newSettingsIndices[sectionHeaderKey] = output.push(
                SectionHeader.fromParsedSectionName(parsedSectionName).toIniSectionName(filetype)
            )
            outputNewSettings(parsedSectionSettings, newSettingsIndices, output)
        }
    }

    // The rewritten file keeps the mode of the file it replaces
    let mode = newFileMode

    // Backup file just in case
    if (filepathExists) {
        const existingMode = (await stat(filepath)).mode & 0o777
        // Credentials files are owner-only
        mode = filetype === IniFileType.credentials ? existingMode & ~0o077 : existingMode

        // Apply before the rename so the backup has the same mode
        if (mode !== existingMode) {
            await chmod(filepath, mode)
        }

        await rename(filepath, filepath + '~')
    }

    await mkdir(path.dirname(filepath), { mode: newDirectoryMode, recursive: true })
    // The file was renamed away or did not exist, so it is created here with mode
    await writeFile(filepath, output.join(EOL), { encoding: 'utf-8', flush: true, mode })
}

function compareObjectEntries(a?: [string, unknown], b?: [string, unknown]): number {
    return ((a && a[0]) || '').localeCompare((b && b[0]) || '')
}

function outputNewSettings(iniSection: IniSection, newSettingsIndices: Record<string, number>, output: string[]): void {
    newSettingsIndices[nextSettingKey] ||= newSettingsIndices[sectionHeaderKey]

    for (const [settingName, settingValue] of Object.entries(iniSection).sort(compareObjectEntries)) {
        if (settingName && settingValue) {
            const setting =
                settingName.indexOf(CONFIG_PREFIX_SEPARATOR) !== -1
                    ? Setting.fromParsedSettingName(settingName, settingValue)
                    : new Setting(settingName, settingValue)

            // Insert subsection header if necessary
            if (setting.subsection && !newSettingsIndices[setting.subsection]) {
                output.splice(newSettingsIndices[nextSettingKey], 0, setting.toIniSubsectionHeaderLine())
                newSettingsIndices[setting.subsection] = newSettingsIndices[nextSettingKey] += 1
            }

            output.splice(newSettingsIndices[setting.subsection || nextSettingKey], 0, setting.toIniSettingLine())
            newSettingsIndices[nextSettingKey] += 1
        }
    }
}

class IniFileIterator implements IterableIterator<string> {
    // Based on regexes from smithy-typescript package for compatability with AWS SDK for JavaScript
    // https://github.com/smithy-lang/smithy-typescript/blob/main/packages/shared-ini-file-loader/src/parseIni.ts
    private static readonly commentRegex = /^\s*[#;].*$/
    private static readonly emptyLineRegex = /^\s*$/
    private static readonly sectionHeaderRegex =
        /^\s*\[(?:(?<type>profile|services|sso-session)\s)?(?<name>.+)\](?<comment>\s*[#;].*)?\s*$/
    private static readonly settingRegex = /^(?<name>\w+)\s*=\s*(?<value>.+?)(?<comment>\s+[#;].*)?\s*$/
    private static readonly subsectionHeaderRegex = /^(?<name>\w+)\s*=(?<comment>\s+[#;].*)?\s*$/
    private static readonly subsectionSettingRegex =
        /^(?<indent>\s+)(?<name>\w+)\s*=\s*(?<value>.+?)(?<comment>\s+[#;].*)?\s*$/

    constructor(
        private readonly it: IterableIterator<string>,
        private readonly output?: string[]
    ) {
        this.return = it.return
        this.throw = it.throw
    }

    [Symbol.iterator](): IterableIterator<string> {
        return this
    }

    return?: (value?: string) => IteratorResult<string, string>

    throw?: (e?: Error) => IteratorResult<string, Error>

    next(...args: [] | [undefined]): IteratorResult<string, string> {
        let done, value
        for ({ done, value } = this.it.next(...args); !done; { done, value } = this.it.next(...args)) {
            if (value === undefined || value === null) {
                continue
            }

            if (IniFileIterator.commentRegex.test(value) || IniFileIterator.emptyLineRegex.test(value)) {
                this.output?.push(value)
                continue
            }

            break
        }

        return {
            done,
            value,
        }
    }

    nextSectionHeader(
        settingHandler?: (setting: Setting) => void
    ): IteratorResult<SectionHeader | undefined, SectionHeader | undefined> {
        for (let subsection, { done, value } = this.next(); !done; { done, value } = this.next()) {
            const sectionHeader = IniFileIterator.sectionHeaderRegex.exec(value)
            if (sectionHeader?.groups) {
                return {
                    done,
                    value: new SectionHeader(
                        sectionHeader.groups.name,
                        sectionHeader.groups.type as IniSectionType,
                        sectionHeader.groups.comment
                    ),
                }
            }

            if (settingHandler) {
                // Check if a subsection is starting
                const subsectionHeader = IniFileIterator.subsectionHeaderRegex.exec(value)
                if (subsectionHeader?.groups) {
                    subsection = subsectionHeader.groups.name
                    continue
                }

                // If active subsection, try to get subsection setting
                let setting = subsection && IniFileIterator.subsectionSettingRegex.exec(value)
                if (!setting) {
                    // If no active subsection, just try to get regular setting
                    setting = IniFileIterator.settingRegex.exec(value)

                    // Deactivate subsection if a regular setting was found (end of the subsection)
                    if (subsection && setting) {
                        subsection = undefined
                    }
                }

                // Read tolerant on setting case name, but convert to lowercase for best compatability
                // with AWS SDKs on load/write
                if (setting?.groups) {
                    settingHandler(
                        new Setting(setting.groups.name.toLowerCase(), setting.groups.value, {
                            comment: setting.groups.comment,
                            indent: setting.groups.indent,
                            subsection,
                        })
                    )
                } else {
                    // If we got here, probably a malformed line, emit it as a comment to preserve it
                    this.output?.push(`# ${value}`)
                }
            }
        }

        return {
            done: true,
            value: undefined,
        }
    }
}
