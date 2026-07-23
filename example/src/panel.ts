/**
 * Tiny self-contained ext-apps panel used to self-test the harness against a
 * real `App` implementation. Renders a repo list from `structuredContent` and
 * a Save button that calls a server tool, gated on `serverTools` capability.
 */
import { App } from "@modelcontextprotocol/ext-apps";

interface RepoListContent {
  repos: Array<{ id: string; name: string; starred: boolean }>;
}

const app = new App({ name: "example-repos-panel", version: "1.0.0" }, {});

const root = document.getElementById("root")!;

function render(content: RepoListContent | undefined) {
  const repos = content?.repos ?? [];
  root.innerHTML = `
    <ul id="repo-list">
      ${repos
        .map(
          (r) =>
            `<li data-repo-id="${r.id}">${r.name}${r.starred ? " ★" : ""}</li>`,
        )
        .join("")}
    </ul>
    <button id="save-btn" type="button">Save</button>
    <button id="docs-btn" type="button">Open docs</button>
    <button id="protocol-btn" type="button">Test protocol methods</button>
    <div id="status"></div>
    <div id="link-status"></div>
    <div id="protocol-status"></div>
  `;

  const saveBtn = document.getElementById("save-btn")!;
  saveBtn.addEventListener("click", async () => {
    const status = document.getElementById("status")!;
    if (!app.getHostCapabilities()?.serverTools) {
      status.textContent = "server tools unavailable";
      return;
    }
    status.textContent = "saving...";
    try {
      const result = await app.callServerTool({
        name: "repos_set",
        arguments: { repos: repos.map((r) => r.id) },
      });
      status.textContent = result.isError ? "save failed" : "saved";
    } catch (err) {
      status.textContent = `error: ${(err as Error).message}`;
    }
  });

  const docsBtn = document.getElementById("docs-btn")!;
  docsBtn.addEventListener("click", async () => {
    const linkStatus = document.getElementById("link-status")!;
    if (!app.getHostCapabilities()?.openLinks) {
      linkStatus.textContent = "open links unavailable";
      return;
    }
    try {
      const result = await app.openLink({ url: "https://example.com/docs" });
      linkStatus.textContent = result.isError ? "link denied" : "link opened";
    } catch (err) {
      linkStatus.textContent = `error: ${(err as Error).message}`;
    }
  });

  // Exercises the four AppRequest methods whose result schemas have required
  // fields (mode / resources / contents / model+content+stopReason), where a
  // naive empty mock response used to fail the SDK's own response validation.
  const protocolBtn = document.getElementById("protocol-btn")!;
  protocolBtn.addEventListener("click", async () => {
    const protocolStatus = document.getElementById("protocol-status")!;
    const parts: string[] = [];

    try {
      const displayMode = await app.requestDisplayMode({ mode: "fullscreen" });
      parts.push(`displayMode=${displayMode.mode}`);
    } catch (err) {
      parts.push(`displayMode-error: ${(err as Error).message}`);
    }

    try {
      const resources = await app.listServerResources();
      parts.push(`resources=${resources.resources.length}`);
    } catch (err) {
      parts.push(`resources-error: ${(err as Error).message}`);
    }

    try {
      const read = await app.readServerResource({ uri: "test://nothing" });
      parts.push(`contents=${read.contents.length}`);
    } catch (err) {
      parts.push(`read-error: ${(err as Error).message}`);
    }

    try {
      await app.createSamplingMessage({
        messages: [{ role: "user", content: { type: "text", text: "hi" } }],
        maxTokens: 10,
      });
      parts.push("sampling=resolved");
    } catch (err) {
      parts.push(`sampling-rejected: ${(err as Error).message}`);
    }

    protocolStatus.textContent = parts.join(" | ");
  });
}

app.addEventListener("toolresult", (params) => {
  render(params.structuredContent as RepoListContent | undefined);
});

app.connect().catch((err) => {
  root.textContent = `connect failed: ${(err as Error).message}`;
});
