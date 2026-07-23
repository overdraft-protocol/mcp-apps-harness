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
    <div id="status"></div>
    <div id="link-status"></div>
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
}

app.addEventListener("toolresult", (params) => {
  render(params.structuredContent as RepoListContent | undefined);
});

app.connect().catch((err) => {
  root.textContent = `connect failed: ${(err as Error).message}`;
});
