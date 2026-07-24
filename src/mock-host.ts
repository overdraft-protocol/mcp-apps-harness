/**
 * The mock host: a pure protocol reducer plus two thin transport bindings
 * (Node/jsdom and browser-injected) that share the exact same reducer logic.
 *
 * `handleHostMessage` is executed two different ways:
 *  - Directly, as a normal function call, from the Node/jsdom transport.
 *  - Serialized via `Function.prototype.toString()` and re-materialized inside
 *    a Chromium page (see `buildBrowserHostScript`), because postMessage only
 *    works between real Window objects living in the same process/page.
 *
 * For the second path to produce byte-identical behavior, `handleHostMessage`
 * MUST be self-contained: no references to anything outside its own `msg`/`state`
 * parameters (no closures over module-level imports or constants). All host
 * identity/config (protocol version, hostInfo, capabilities, theme, fixture)
 * travels inside `state`, which Node constructs once via `createMockHostState`
 * and then either mutates in place (jsdom) or JSON-serializes into the page
 * (Chromium).
 */
import {
  CallToolResultLike,
  HOST_INFO,
  HarnessCapabilities,
  JsonRpcMessage,
  OpenLinkAttempt,
  PROTOCOL_VERSION,
  ResolvedHarnessCapabilities,
  Theme,
  UnmappedToolCall,
  normalizeFixtureToToolResult,
  resolveCapabilities,
} from "./protocol.js";

export interface MockHostState {
  initialized: boolean;
  protocolVersion: string;
  hostInfo: { name: string; version: string };
  capabilities: ResolvedHarnessCapabilities;
  theme: Theme;
  fixture: CallToolResultLike;
  toolQueue: Record<string, CallToolResultLike[]>;
  log: {
    unmappedToolCalls: UnmappedToolCall[];
    openLinkAttempts: OpenLinkAttempt[];
  };
}

export function createMockHostState(options: {
  fixture: unknown;
  capabilities?: HarnessCapabilities;
  theme?: Theme;
}): MockHostState {
  return {
    initialized: false,
    protocolVersion: PROTOCOL_VERSION,
    hostInfo: HOST_INFO,
    capabilities: resolveCapabilities(options.capabilities),
    theme: options.theme ?? "light",
    fixture: normalizeFixtureToToolResult(options.fixture),
    toolQueue: {},
    log: { unmappedToolCalls: [], openLinkAttempts: [] },
  };
}

/**
 * Queue a mocked `tools/call` response for the next call to `toolName`.
 * Safe to call from Node (jsdom path mutates `state` directly).
 */
export function queueToolResponse(state: MockHostState, toolName: string, result: CallToolResultLike): void {
  (state.toolQueue[toolName] ??= []).push(result);
}

/**
 * The core protocol reducer: given one incoming JSON-RPC message from the panel
 * (App), returns the JSON-RPC messages the host should send back.
 *
 * SELF-CONTAINED ON PURPOSE — see file header. Do not reference imports/consts
 * from outside this function body; read everything from `state` instead.
 */
export function handleHostMessage(msg: any, state: MockHostState): JsonRpcMessage[] {
  const out: JsonRpcMessage[] = [];
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return out;

  if (msg.method === "ui/initialize" && msg.id !== undefined) {
    const caps: Record<string, unknown> = {};
    if (state.capabilities.openLinks) caps.openLinks = {};
    if (state.capabilities.serverTools) caps.serverTools = {};
    if (state.capabilities.downloadFile) caps.downloadFile = {};
    out.push({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? state.protocolVersion,
        hostInfo: state.hostInfo,
        hostCapabilities: caps,
        hostContext: {
          theme: state.theme,
          displayMode: "inline",
          availableDisplayModes: ["inline"],
          locale: "en-US",
          timeZone: "UTC",
          platform: "web",
        },
      },
    });
    return out;
  }

  if (msg.method === "ui/notifications/initialized") {
    state.initialized = true;
    out.push({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: state.fixture as any,
    });
    return out;
  }

  if (msg.method === "tools/call" && msg.id !== undefined) {
    const name = msg.params?.name;
    const queue = state.toolQueue[name];
    if (queue && queue.length > 0) {
      const result = queue.shift();
      out.push({ jsonrpc: "2.0", id: msg.id, result: result as any });
    } else {
      state.log.unmappedToolCalls.push({ name, arguments: msg.params?.arguments });
      out.push({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [
            {
              type: "text",
              text: `inspect-tools: no mock response configured for tool "${name}"`,
            },
          ],
          isError: true,
        },
      });
    }
    return out;
  }

  if (msg.method === "ui/open-link" && msg.id !== undefined) {
    const url = msg.params?.url;
    state.log.openLinkAttempts.push({ url });
    out.push({
      jsonrpc: "2.0",
      id: msg.id,
      result: state.capabilities.openLinks ? {} : { isError: true },
    });
    return out;
  }

  // These four have REQUIRED result fields (mode / resources / contents /
  // model+content+stopReason) — an empty `{}` fails the App SDK's own zod
  // validation of the response and rejects the app's promise with a schema
  // error that has nothing to do with the panel's own code. Answer with a
  // shape that actually satisfies each schema instead.
  if (msg.method === "ui/request-display-mode" && msg.id !== undefined) {
    // Honor whatever was requested — we don't model real display-mode
    // constraints, so there's nothing to reject it in favor of.
    out.push({ jsonrpc: "2.0", id: msg.id, result: { mode: msg.params?.mode } });
    return out;
  }

  if (msg.method === "resources/list" && msg.id !== undefined) {
    out.push({ jsonrpc: "2.0", id: msg.id, result: { resources: [] } });
    return out;
  }

  if (msg.method === "resources/templates/list" && msg.id !== undefined) {
    out.push({ jsonrpc: "2.0", id: msg.id, result: { resourceTemplates: [] } });
    return out;
  }

  if (msg.method === "resources/read" && msg.id !== undefined) {
    // An empty `contents` array is valid per schema (no minimum length) and
    // resolves cleanly, unlike the alternative of guessing at fake content.
    out.push({ jsonrpc: "2.0", id: msg.id, result: { contents: [] } });
    return out;
  }

  if (msg.method === "sampling/createMessage" && msg.id !== undefined) {
    // No valid *empty* CreateMessageResult exists (role/content/model/stopReason
    // are all required) and fabricating fake model output would be actively
    // misleading. A real JSON-RPC error rejects the app's promise cleanly with
    // an explanatory message, the same way a host without sampling support
    // would reject it, instead of a schema-validation crash.
    out.push({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: "inspect-tools: sampling/createMessage is not mocked by this harness" },
    });
    return out;
  }

  // Any other request we don't model explicitly (ui/download-file, ui/message,
  // ui/update-model-context, tools/list, prompts/list, ping, ...): these all
  // have all-optional result shapes, so an empty result resolves the app's
  // pending promise as a (fake, unrecorded) success instead of hanging or
  // crashing. Notifications we don't model (e.g. ui/notifications/size-changed)
  // are silently ignored.
  if (msg.id !== undefined) {
    out.push({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
  return out;
}

/**
 * Structural (not lib.dom-specific) window types so this binds equally well to
 * a real browser `Window` or a jsdom `DOMWindow` without casting at call sites.
 */
export interface MessageEventLike {
  source: unknown;
  data: unknown;
}
export interface HostWindowLike {
  addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
}
export interface TargetWindowLike {
  postMessage(message: unknown, targetOrigin: string): void;
}

/**
 * Node/jsdom transport binding: attach the reducer to a real `window` that has
 * an iframe (the panel) as a child browsing context.
 */
export function attachNodeHostTransport(
  hostWindow: HostWindowLike,
  iframeWindow: TargetWindowLike & object,
  state: MockHostState,
): () => void {
  const listener = (event: MessageEventLike) => {
    if (event.source !== iframeWindow) return;
    const toSend = handleHostMessage(event.data, state);
    for (const message of toSend) {
      iframeWindow.postMessage(message, "*");
    }
  };
  hostWindow.addEventListener("message", listener);
  return () => hostWindow.removeEventListener("message", listener);
}

/**
 * Build a self-contained `<script>` body to inject into a Chromium page that
 * hosts the panel in an iframe with the given `iframeId`. Re-materializes
 * `handleHostMessage` from its own compiled source so the browser-side host
 * runs the identical reducer as the Node/jsdom transport.
 *
 * Exposes on `window`:
 *  - `__mockHostState`  — the live state object (poll `.initialized`, read `.log`)
 *  - `__mockHostPushToolResponse(name, result)` — queue a response ahead of an interact step
 */
export function buildBrowserHostScript(state: MockHostState, iframeId: string): string {
  const stateJson = JSON.stringify(state);
  const reducerSource = handleHostMessage.toString();
  const iframeIdJson = JSON.stringify(iframeId);
  return `(function () {
  var iframe = document.getElementById(${iframeIdJson});
  window.__mockHostState = ${stateJson};
  window.__mockHostHandleMessage = ${reducerSource};
  window.__mockHostPushToolResponse = function (name, result) {
    var queue = window.__mockHostState.toolQueue[name];
    if (!queue) {
      queue = [];
      window.__mockHostState.toolQueue[name] = queue;
    }
    queue.push(result);
  };
  window.addEventListener("message", function (event) {
    if (!iframe || event.source !== iframe.contentWindow) return;
    var toSend = window.__mockHostHandleMessage(event.data, window.__mockHostState);
    for (var i = 0; i < toSend.length; i++) {
      iframe.contentWindow.postMessage(toSend[i], "*");
    }
  });
})();`;
}
