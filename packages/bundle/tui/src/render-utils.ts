/** Pure formatting helpers shared by the plain and interactive session projections. */

/** The structural slice of a content block used by terminal previews. */
export interface PreviewBlock {
  readonly type: string
  readonly text?: string
  readonly content?: readonly PreviewBlock[]
  readonly isError?: boolean
}

/**
 * Squash a value onto one bounded line for inline previews.
 * @param text - Raw text that may contain whitespace or line breaks.
 * @param max - Maximum returned character count.
 * @returns A trimmed single-line preview with an ellipsis when truncated.
 */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * Join text blocks, unwrapping tool-result wrappers.
 * @param content - Structurally typed message content to flatten.
 * @returns Concatenated human-readable text blocks.
 */
export function textOf(content: readonly PreviewBlock[]): string {
  return content.map(block =>
    block.type === 'text' ? block.text ?? ''
      : block.type === 'tool-result' ? textOf(block.content ?? [])
        : '').join('')
}

/**
 * Whether any tool-result wrapper marks a failed call.
 * @param content - Structurally typed message content to inspect.
 * @returns True when a top-level tool-result wrapper carries `isError`.
 */
export function isErrorResult(content: readonly PreviewBlock[]): boolean {
  return content.some(block => block.type === 'tool-result' && block.isError === true)
}

/**
 * Render token counts as a compact `1.2k` style figure.
 * @param tokens - Non-negative token count from model usage.
 * @returns The integer count below one thousand, otherwise one decimal in thousands.
 */
export function figure(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
}
