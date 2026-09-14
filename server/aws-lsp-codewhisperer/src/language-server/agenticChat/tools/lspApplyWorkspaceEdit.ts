import { Features } from '@aws/language-server-runtimes/server-interface/server'
import { InvokeOutput } from './toolShared'

export interface TextEdit {
    range: {
        start: { line: number; character: number }
        end: { line: number; character: number }
    }
    newText: string
}

export interface WorkspaceEdit {
    changes: {
        [uri: string]: TextEdit[]
    }
}

export type LspApplyWorkspaceEditParams = {
    edit: WorkspaceEdit
}

export class LspApplyWorkspaceEdit {
    private readonly logging: Features['logging']
    private readonly lsp: Features['lsp']

    constructor(features: Pick<Features, 'lsp' | 'logging'> & Partial<Features>) {
        this.logging = features.logging
        this.lsp = features.lsp
    }

    // TODO (workspace-boundary hardening): this tool applies edits without a
    // workspace-boundary or acceptance check. For parity with the file tools,
    // add symlink-aware boundary validation and approval gating that mirror the
    // fs* write tools (resolve each edited URI via requiresPathAcceptance)
    // before this tool is enabled. Note this tool is not currently registered
    // in any runtime (LspToolsServer is not enabled).
    public async invoke(params: LspApplyWorkspaceEditParams): Promise<InvokeOutput> {
        try {
            if (!params.edit || !params.edit.changes) {
                return {
                    output: {
                        kind: 'text',
                        content: 'No valid workspace edit provided.',
                    },
                }
            }

            // Count the number of edits to be applied
            let totalEdits = 0
            const documentUris = Object.keys(params.edit.changes)

            for (const uri of documentUris) {
                totalEdits += params.edit.changes[uri].length
            }

            if (totalEdits === 0) {
                return {
                    output: {
                        kind: 'text',
                        content: 'No edits to apply.',
                    },
                }
            }

            // Apply the workspace edit
            const result = await this.lsp.workspace.applyWorkspaceEdit({ edit: params.edit })

            if (result.applied) {
                return {
                    output: {
                        kind: 'text',
                        content: `Successfully applied ${totalEdits} edit(s) to ${documentUris.length} document(s).`,
                    },
                }
            } else {
                return {
                    output: {
                        kind: 'text',
                        content: `Failed to apply edits: ${result.failureReason || 'Unknown reason'}`,
                    },
                }
            }
        } catch (error) {
            this.logging.error(`Error applying workspace edit: ${error}`)
            return {
                output: {
                    kind: 'text',
                    content: `Error applying workspace edit: ${error}`,
                },
            }
        }
    }

    public static getSpec() {
        return {
            name: 'lspApplyWorkspaceEdit',
            description:
                'Apply edits to one or more documents that are currently open in the editor. ' +
                'This tool is useful for making changes to files the user is currently working on.',
            inputSchema: {
                type: 'object',
                properties: {
                    edit: {
                        type: 'object',
                        description: 'The workspace edit to apply',
                        properties: {
                            changes: {
                                type: 'object',
                                description: 'Map of document URIs to text edits',
                                additionalProperties: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            range: {
                                                type: 'object',
                                                description: 'The range of text to replace',
                                                properties: {
                                                    start: {
                                                        type: 'object',
                                                        description: 'The start position',
                                                        properties: {
                                                            line: {
                                                                type: 'number',
                                                                description: 'Line position (zero-based)',
                                                            },
                                                            character: {
                                                                type: 'number',
                                                                description: 'Character position (zero-based)',
                                                            },
                                                        },
                                                        required: ['line', 'character'],
                                                    },
                                                    end: {
                                                        type: 'object',
                                                        description: 'The end position',
                                                        properties: {
                                                            line: {
                                                                type: 'number',
                                                                description: 'Line position (zero-based)',
                                                            },
                                                            character: {
                                                                type: 'number',
                                                                description: 'Character position (zero-based)',
                                                            },
                                                        },
                                                        required: ['line', 'character'],
                                                    },
                                                },
                                                required: ['start', 'end'],
                                            },
                                            newText: {
                                                type: 'string',
                                                description: 'The new text to replace with',
                                            },
                                        },
                                        required: ['range', 'newText'],
                                    },
                                },
                            },
                        },
                        required: ['changes'],
                    },
                },
                required: ['edit'],
            } as const,
        }
    }
}
