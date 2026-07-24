/**
 * ext-apps host-side message shapes/constants.
 *
 * These mirror `@modelcontextprotocol/ext-apps`'s `spec.types.ts` closely enough to
 * type our mock host, without importing the package's zod schemas at runtime (the
 * mock-host core must stay serializable via `Function.prototype.toString()` for the
 * Chromium runner — see mock-host.ts).
 */

/** Protocol version this harness's mock host negotiates by default. */
export const PROTOCOL_VERSION = "2026-01-26";

export const HOST_INFO = {
  name: "inspect-tools",
  version: "0.1.0",
} as const;

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** Capabilities the harness's mock host can advertise to a panel, per render. */
export interface HarnessCapabilities {
  /** Host can proxy `tools/call` to a (mocked) MCP server. Default: true. */
  serverTools?: boolean;
  /** Host supports `ui/open-link`. Default: true. */
  openLinks?: boolean;
  /** Host supports `ui/download-file`. Default: false. */
  downloadFile?: boolean;
}

export interface ResolvedHarnessCapabilities {
  serverTools: boolean;
  openLinks: boolean;
  downloadFile: boolean;
}

export function resolveCapabilities(capabilities?: HarnessCapabilities): ResolvedHarnessCapabilities {
  return {
    serverTools: capabilities?.serverTools ?? true,
    openLinks: capabilities?.openLinks ?? true,
    downloadFile: capabilities?.downloadFile ?? false,
  };
}

/** A CallToolResult-shaped object, as sent over `ui/notifications/tool-result`. */
export interface CallToolResultLike {
  content?: unknown[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Fixtures are usually just the `structuredContent` payload a real tool call would
 * have returned. If the caller already hands us a full CallToolResult shape (has a
 * `content` array), we pass it through as-is; otherwise we wrap it.
 */
export function normalizeFixtureToToolResult(fixture: unknown): CallToolResultLike {
  if (
    fixture &&
    typeof fixture === "object" &&
    Array.isArray((fixture as Record<string, unknown>).content)
  ) {
    return fixture as CallToolResultLike;
  }
  return {
    content: [],
    structuredContent: (fixture ?? {}) as Record<string, unknown>,
    isError: false,
  };
}

export type Theme = "light" | "dark";

export interface Viewport {
  width?: number;
  height?: number;
  theme?: Theme;
}

export const DEFAULT_VIEWPORT: Required<Viewport> = {
  width: 1024,
  height: 768,
  theme: "light",
};

/**
 * Replace the *body* of every `<script>` with a short placeholder, keeping the
 * tags and their attributes.
 *
 * Panels are single-file builds with the whole bundle inlined, so the raw
 * serialized DOM is dominated by the megabyte of JS you fed in — which is the
 * build input, not the render output, and drowns the actual rendered markup
 * (and, for an MCP client, burns the context window for nothing). Callers that
 * genuinely want the script bodies can pass `includeScripts: true`.
 */
export function stripScriptBodies(html: string): string {
  return html.replace(
    /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_match, open: string, body: string, close: string) =>
      body.trim().length === 0 ? `${open}${body}${close}` : `${open}/* ${body.length} chars elided by inspect-tools */${close}`,
  );
}

/** One step of an `interact` sequence. */
export interface InteractAction {
  type: "click" | "fill";
  /** CSS selector, resolved inside the panel's document. */
  selector: string;
  /** Text to enter, required for `type: "fill"`. */
  value?: string;
}

export interface InteractStep {
  action: InteractAction;
  /**
   * If this action is expected to trigger `app.callServerTool(...)`, queue the
   * mocked response here. The mock host pops the next queued response for the
   * named tool when it sees a matching `tools/call` request.
   */
  respondWith?: {
    tool: string;
    result: CallToolResultLike;
  };
}

export interface UnmappedToolCall {
  name: string;
  arguments: unknown;
}

export interface OpenLinkAttempt {
  url: string;
}

export interface ConsoleMessage {
  type: string;
  text: string;
}

export interface CapturedError {
  message: string;
  stack?: string;
}

export interface RenderResult {
  dom: string;
  screenshot?: string;
  consoleMessages: ConsoleMessage[];
  errors: CapturedError[];
  unmappedToolCalls: UnmappedToolCall[];
  openLinkAttempts: OpenLinkAttempt[];
}
