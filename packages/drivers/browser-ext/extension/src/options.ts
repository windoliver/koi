import { createExtensionStorage } from "./storage.js";

function renderList(container: HTMLElement, values: readonly string[]): void {
  container.innerHTML = "";
  for (const value of values) {
    const item = document.createElement("li");
    item.textContent = value;
    container.appendChild(item);
  }
}

async function main(): Promise<void> {
  const root = document.getElementById("app");
  if (!(root instanceof HTMLElement)) return;

  const storage = createExtensionStorage();
  const [local, session] = await Promise.all([storage.getLocalState(), storage.getSessionState()]);

  root.innerHTML = `
    <section>
      <h1>Koi Browser Extension</h1>
      <p>Instance name: <strong>${local.extensionName}</strong></p>
      <p>Instance ID: <code>${local.instanceId ?? "pending"}</code></p>
      <p>Browser session: <code>${session.browserSessionId ?? "pending"}</code></p>
      <h2>Always Grants</h2>
      <ul id="always-grants"></ul>
      <h2>Private-Origin Allowlist</h2>
      <ul id="private-origin-allowlist"></ul>
    </section>
  `;

  const alwaysContainer = document.getElementById("always-grants");
  const allowlistContainer = document.getElementById("private-origin-allowlist");
  if (alwaysContainer instanceof HTMLElement) {
    renderList(alwaysContainer, Object.keys(local.alwaysGrants));
  }
  if (allowlistContainer instanceof HTMLElement) {
    renderList(allowlistContainer, local.privateOriginAllowlist);
  }
}

void main();
