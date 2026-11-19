// Error message constants
export const GENERIC_ERROR_MS = 'An unexpected error occurred, check the logs for more information.'
export const OUTPUT_LIMIT_EXCEEDS_PARTIAL_MSG = 'output exceeds maximum character limit of'
export const RESPONSE_TIMEOUT_PARTIAL_MSG = 'Response processing timed out after'
export const INCOMPLETE_TOOL_USE_RETRY_LIMIT_MSG =
    'Amazon Q could not complete a tool request because its input was cut off repeatedly. Try asking for a smaller change, or generating the content in sections.'

// Retry limits
// Maximum number of consecutive responses with an incomplete tool-use input that will be
// retried before giving up and surfacing an error to the user.
export const MAX_INCOMPLETE_TOOL_USE_RETRIES = 3

// Telemetry reason codes reported on the amazonq_invokeLLM metric.
//
// An incomplete tool-use input is retried inside the agent loop and usually recovers within the
// same user turn, so it is not a user-visible failure. These codes let downstream metrics exclude
// those transient iterations from per-call success rates while still counting the terminal
// give-up, which the user does see, as a genuine failure. `result` stays 'Failed' in both cases
// so raw failure counts remain intact for diagnostics.
//
// NOTE: these string values form part of the telemetry contract and are consumed by a downstream
// metrics pipeline. Do not rename either value without updating that consumer first.
export const INVOKE_LLM_REASON_INCOMPLETE_TOOL_USE_RETRYING = 'INCOMPLETE_TOOL_USE_RETRYING'
export const INVOKE_LLM_REASON_INCOMPLETE_TOOL_USE_EXHAUSTED = 'INCOMPLETE_TOOL_USE_EXHAUSTED'

// Time Constants
export const LOADING_THRESHOLD_MS = 2000
export const CLIENT_TIMEOUT_MS = 245_000
export const RESPONSE_TIMEOUT_MS = 240_000
export const SERVICE_MANAGER_TIMEOUT_MS = 10_000 //10 seconds
export const SERVICE_MANAGER_POLL_INTERVAL_MS = 100

// Compaction
export const COMPACTION_BODY = (threshold: number) =>
    `The context window is almost full (${threshold}%) and exceeding it will clear your history. Amazon Q can compact your history instead.`
export const COMPACTION_HEADER_BODY = 'Compact chat history?'
export const COMPACTION_PROMPT = `
[SYSTEM NOTE: This is an automated summarization request, not from the user]\n\n
<task>
Your task is to generate a concise summary of the conversation history between an AI coding agent (assistant) and user once the LLM context window is reached.
This summary will replace the raw conversation history, so it should contain important information from the history such that it enables continuning the conversation with the user in a coherent manner.
Output the summary in markdown format with sections provided in format tag.
</task>

<format>
The summary should have following main sections:
## Conversation Summary
- contains an entry for each key topic discussed
## Files and Code Summary
- contains entries on what was learned about the files and code discussed. If relevant, it includes file paths, function signatures, and key changes
## Key Insights
- contains a summary for each key insight learned from the conversation (such as user preferences, technical details, decisions made, etc.)
## Most Recent Topic
- contains a detailed summary of the most recent topic discussed along with details of actions taken so far to address the user needs along with ALL tools executed
</format>

<guidelines>
- Add an entry to Key Insights section for any SIGNIFICANT tool usages whose result is important for continuing the conversation
- DO NOT respond conversationally. DO NOT address the user directly.
- For files that were read/written, exclude the full raw content but keep their path and what was learned about them
- If a file was loaded multiple times, only keep information about its latest fetch
- For code pieces, capture file paths and key changes
- Summarize code content concisely rather than including full snippets
- Remove chat conventions (greetings, offers to help, etc.)
- Only output the summary and nothing else
</guidelines>

<prioritize>
- Information essential for continuing the conversation effectively
- Technical details and code patterns that maintain context
- User primary goals and requirements
- Adding more details for recent conversations/actions over older ones
</prioritize>

<example_output>
## Conversation Summary
- **Topic1**: Summary of what was done to address Topic1 and the final conclusion
- **Topic2**: Summary of what was done to address Topic2 and the final conclusion

## Files and Code Summary
- **fileA path**: learnings about fileA
- **fileB path**: learnings about fileB
- **codeSnippetA**: learnings from codeSnippetA

## Key Insights
- **INSIGHT**: Insight1
- **INSIGHT**: Insight2

## Most Recent Topic
**Topic**: the most recent topic being discussed
**Progress**: Key actions taken so far to address the topic
**Tools Used**:
- **toolUsage1**: Summary of what was done in toolUsage1 and ultimate result
</example_output>
`

// Retry Strategy Constants
export const RETRY_BASE_DELAY_MS = 1000
export const RETRY_MAX_DELAY_MS = 10000
export const RETRY_JITTER_MIN = 0.5
export const RETRY_JITTER_MAX = 1.0
export const RETRY_DELAY_NOTIFICATION_THRESHOLD_MS = 2000
export const RETRY_BACKOFF_MULTIPLIER = 2

// HTTP Status Codes
export const HTTP_STATUS_TOO_MANY_REQUESTS = 429
export const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500

// Error Messages
export const MONTHLY_LIMIT_ERROR_MARKER = 'MONTHLY_REQUEST_COUNT'
export const CONTENT_LENGTH_EXCEEDS_THRESHOLD = 'CONTENT_LENGTH_EXCEEDS_THRESHOLD'
export const HIGH_LOAD_ERROR_MESSAGE =
    'Encountered unexpectedly high load when processing the request, please try again.'
export const SERVICE_UNAVAILABLE_EXCEPTION = 'ServiceUnavailableException'
export const INSUFFICIENT_MODEL_CAPACITY = 'INSUFFICIENT_MODEL_CAPACITY'
export const INVALID_MODEL_ID = 'INVALID_MODEL_ID'
export const SERVICE_QUOTA_EXCEPTION = 'ServiceQuotaExceededException'
export const MAXIMUM_CHAT_CONTENT_MESSAGE = 'Exceeded max chat context length.'

// Delay tracking constants
export const MINOR_DELAY_THRESHOLD_MS = 2000 // 2 seconds
export const MAJOR_DELAY_THRESHOLD_MS = 5000 // 5 seconds
export const MAX_RETRY_DELAY_MS = 10000 // 10 seconds

// Stalled stream protection constants
export const STALLED_STREAM_GRACE_PERIOD_MS = 300000 // 5 minutes
export const STALLED_STREAM_CHECK_INTERVAL_MS = 1000 // 1 second

// Request attempt tracking
export const MAX_REQUEST_ATTEMPTS = 3

// FsRead limits
export const FSREAD_MAX_PER_FILE = 200_000
export const FSREAD_MAX_TOTAL = 400_000
export const FSREAD_MEMORY_BANK_MAX_PER_FILE = 20_000
export const FSREAD_MEMORY_BANK_MAX_TOTAL = 100_000

// Memory Bank constants
// Temporarily reduced from recommended 20 to 5 for token optimization
export const MAX_NUMBER_OF_FILES_FOR_MEMORY_BANK_RANKING = 5

// shortcut constant
export const DEFAULT_MACOS_RUN_SHORTCUT = '&#8679; &#8984; &#8629;'
export const DEFAULT_WINDOW_RUN_SHORTCUT = 'Ctrl + &#8679; + &#8629;'
export const DEFAULT_LINUX_RUN_SHORTCUT = 'Meta + &#8679; + &#8629;'
export const DEFAULT_MACOS_STOP_SHORTCUT = '&#8679; &#8984; &#9003;'
export const DEFAULT_WINDOW_STOP_SHORTCUT = 'Ctrl + &#8679; + &#9003;'
export const DEFAULT_LINUX_STOP_SHORTCUT = 'Meta + &#8679; + &#9003;'
export const DEFAULT_MACOS_REJECT_SHORTCUT = '&#8679; &#8984; R'
export const DEFAULT_WINDOW_REJECT_SHORTCUT = 'Ctrl + &#8679; + R'
export const DEFAULT_LINUX_REJECT_SHORTCUT = 'Meta + &#8679; + R'
