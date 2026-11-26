// Types for index.mjs: the surface of html-components/telegram the plugin uses.

export type ComponentErrorCode = 'UNKNOWN_PACK' | 'INVALID_DATA' | 'CHAT_DATA_LIMIT' | 'HTML_LIMIT'

export type RenderResult =
  // variant 'static': a visual pack over the size budget re-rendered without its chart script.
  | { html: string; caption: string; variant?: 'static'; error?: undefined }
  | { error: { code: ComponentErrorCode }; html?: undefined; caption?: undefined }

export function renderComponent(name: string, data: unknown, opts?: { chatData?: boolean }): RenderResult

export function validate(name: string, data: unknown): boolean

// Per-pack template: `caption` builds the plain-text version of VALID data
// (it may throw on data that failed validation).
export interface PackTemplate {
  caption: (data: unknown) => string
}

export const templates: Record<string, PackTemplate | undefined>
