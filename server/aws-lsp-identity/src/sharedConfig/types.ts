import { CONFIG_PREFIX_SEPARATOR } from '@smithy/shared-ini-file-loader'
import { IniSectionType } from '@smithy/types'

// Each serialized section header or setting is exactly one line
function assertSingleLine(line: string): string {
    if (/[\r\n]/.test(line)) {
        throw new Error('Shared config entries cannot contain line breaks.')
    }

    return line
}

export enum IniFileType {
    config,
    credentials,
}

export class SectionHeader {
    constructor(
        readonly name: string,
        readonly type: IniSectionType = IniSectionType.PROFILE,
        readonly comment?: string
    ) {}

    toIniSectionName(filetype: IniFileType): string {
        const showType =
            filetype === IniFileType.config && !(this.type == IniSectionType.PROFILE && this.name === 'default')
        return assertSingleLine('[' + (showType ? this.type + ' ' : '') + this.name + ']' + (this.comment ?? ''))
    }

    static fromParsedSectionName(parsedSectionName: string): SectionHeader {
        const separatorIndex = parsedSectionName.indexOf(CONFIG_PREFIX_SEPARATOR)
        if (separatorIndex === -1) {
            return new SectionHeader(parsedSectionName)
        }

        const sectionTypeName = parsedSectionName.substring(0, separatorIndex)
        if (Object.values(IniSectionType).includes(sectionTypeName as IniSectionType)) {
            return new SectionHeader(parsedSectionName.substring(separatorIndex + 1), sectionTypeName as IniSectionType)
        }

        // While dots are not allowed in section names based on the public docs, they are handled by SDKs, so
        // be tolerant if dots are used and assume it's a profile if not one of the well-known section types
        // can be detected.
        // https://docs.aws.amazon.com/sdkref/latest/guide/file-format.html#file-format-config
        return new SectionHeader(parsedSectionName)
    }

    toParsedSectionName(): string {
        return this.type === IniSectionType.PROFILE ? this.name : `${this.type}.${this.name}`
    }
}

export type SettingOptions = { comment?: string; indent?: string; subsection?: string }

export class Setting {
    static readonly defaultIndent = '  '

    comment?: string
    indent?: string
    readonly subsection?: string

    constructor(
        readonly name: string,
        public value: string,
        options?: SettingOptions
    ) {
        this.comment = options?.comment
        this.indent = options?.indent
        this.subsection = options?.subsection
    }

    static fromParsedSettingName(parsedSettingName: string, value: string, options?: SettingOptions): Setting {
        const components = parsedSettingName.split(CONFIG_PREFIX_SEPARATOR)
        return new Setting(components[1], value, { ...options, subsection: components[0] })
    }

    toParsedSettingName(): string {
        return (this.subsection ? this.subsection + CONFIG_PREFIX_SEPARATOR : '') + this.name
    }

    toIniSubsectionHeaderLine(): string {
        return assertSingleLine(`${this.subsection} =${this.comment || ''}`)
    }

    toIniSettingLine(): string {
        const indent = this.subsection ? this.indent || Setting.defaultIndent : ''
        return assertSingleLine(`${indent}${this.name} = ${this.value}${this.comment || ''}`)
    }
}
