// ═══════════════════════════════════
//  tAbZ — Smart Tab Management
// ═══════════════════════════════════
// Self-contained popup module integrated into SuperLevels.
// Kept in its own file (plus a nav button + page + <script> tag in
// popup.html and a "tabGroups" permission in manifest.json) so upstream
// SuperLevels merges stay conflict-free. All tab operations run directly
// from the popup, so background.js is untouched.
//
// Ported from the standalone tAbZ extension:
//   - removeDuplicates : close duplicate tabs across all windows
//   - moveUngrouped    : move ungrouped, non-pinned tabs to a new window
//   - sortTabs         : sort ungrouped, non-pinned tabs in the current window
//   - exportUrls       : copy every open tab's URL to the clipboard
//   - whitelist        : domains where only an exact URL counts as a duplicate

(function () {
  const WHITELIST_KEY = "tabz_domainList";
  const DEFAULT_DOMAINS = ["youtube.com", "filelist.io"];

  // ── Tab identity / dedup helpers (from tabUtils.js) ──
  function groupTabsByIdentity(tabs, domainList) {
    const groups = {};
    for (const tab of tabs) {
      let url;
      try {
        url = new URL(tab.url);
      } catch {
        // Skip invalid URLs (about:blank, data:, empty, etc.)
        continue;
      }
      const hostname = url.hostname.replace(/^www\./, "");
      const identity = domainList.includes(hostname)
        ? url.href
        : url.origin + url.pathname;
      (groups[identity] = groups[identity] || []).push(tab);
    }
    return groups;
  }

  // Keep the most important tab: pinned > grouped > oldest (lowest id)
  function getOriginalTab(tabs) {
    return [...tabs].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const aGrouped = a.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE;
      const bGrouped = b.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE;
      if (aGrouped !== bGrouped) return aGrouped ? -1 : 1;
      return a.id - b.id;
    })[0];
  }

  async function closeDuplicateTabs(originalTab, tabs) {
    const duplicates = tabs.filter((t) => t.id !== originalTab.id);
    const results = await Promise.allSettled(
      duplicates.map((t) => chrome.tabs.remove(t.id))
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    return { closed: duplicates.length - failed, failed };
  }

  // ── Operations ──
  async function removeDuplicateTabs() {
    const domainList = await getDomains();
    const tabs = await chrome.tabs.query({});
    const groups = groupTabsByIdentity(tabs, domainList);

    let closed = 0;
    let failed = 0;
    for (const identity in groups) {
      if (groups[identity].length > 1) {
        const original = getOriginalTab(groups[identity]);
        const r = await closeDuplicateTabs(original, groups[identity]);
        closed += r.closed;
        failed += r.failed;
      }
    }
    if (failed > 0) {
      throw new Error(`Closed ${closed} duplicate${plural(closed)}, failed on ${failed}`);
    }
    return closed
      ? `Removed ${closed} duplicate tab${plural(closed)}`
      : "No duplicate tabs found";
  }

  async function moveUngroupedTabs() {
    const allTabs = await chrome.tabs.query({});

    // Clean up empty new-tab pages first
    const emptyTabs = allTabs.filter((t) => t.url === "chrome://newtab/");
    if (emptyTabs.length) {
      await chrome.tabs.remove(emptyTabs.map((t) => t.id));
    }

    const remaining = await chrome.tabs.query({});
    const ungrouped = remaining.filter(
      (t) => t.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE && !t.pinned
    );
    if (!ungrouped.length) return "No ungrouped tabs to move";

    const newWindow = await chrome.windows.create({ focused: true });
    await Promise.all(
      ungrouped.map((t) =>
        chrome.tabs.move(t.id, { windowId: newWindow.id, index: -1 })
      )
    );

    // Close the blank tab the new window opened with
    const defaultTab = (await chrome.tabs.query({ windowId: newWindow.id })).find(
      (t) => t.url === "" || t.url === "chrome://newtab/"
    );
    if (defaultTab) await chrome.tabs.remove(defaultTab.id);

    return `Moved ${ungrouped.length} tab${plural(ungrouped.length)} to a new window`;
  }

  async function sortTabsByDomain() {
    // Target the last-focused normal browser window, not the popup itself
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    const tabs = await chrome.tabs.query({ windowId: win.id });
    const ungrouped = tabs.filter(
      (t) => t.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE && !t.pinned
    );
    if (ungrouped.length < 2) return "Not enough ungrouped tabs to sort";

    ungrouped.sort((a, b) => {
      try {
        return new URL(a.url).hostname.localeCompare(new URL(b.url).hostname);
      } catch {
        return 0;
      }
    });
    await chrome.tabs.move(
      ungrouped.map((t) => t.id),
      { index: ungrouped[0].index }
    );
    return `Sorted ${ungrouped.length} tab${plural(ungrouped.length)} by domain`;
  }

  async function exportTabUrls() {
    // All windows, in window/tab order: title line, then URL line, per tab
    const tabs = await chrome.tabs.query({});
    const entries = tabs
      .map((t) => ({ url: t.url || t.pendingUrl, title: t.title }))
      .filter((e) => e.url)
      .map((e) => `${(e.title || e.url).replace(/\s+/g, " ").trim()}\n${e.url}`);
    if (!entries.length) return "No tab URLs to export";
    await navigator.clipboard.writeText(entries.join("\n"));
    return `Copied ${entries.length} tab${plural(entries.length)} to clipboard`;
  }

  function plural(n) {
    return n === 1 ? "" : "s";
  }

  // ── Whitelist storage ──
  function getDomains() {
    return new Promise((resolve) => {
      chrome.storage.sync.get({ [WHITELIST_KEY]: null }, (data) => {
        let list = data[WHITELIST_KEY];
        if (list === null) {
          list = DEFAULT_DOMAINS.slice();
          chrome.storage.sync.set({ [WHITELIST_KEY]: list });
        }
        resolve(list);
      });
    });
  }

  function setDomains(list) {
    return new Promise((resolve) =>
      chrome.storage.sync.set({ [WHITELIST_KEY]: list }, resolve)
    );
  }

  function isValidDomain(domain) {
    return /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain);
  }

  // ── UI wiring ──
  function init() {
    injectStyles();

    const page = document.getElementById("page-tabz");
    if (!page) return;

    const countEl = page.querySelector("#tabzCount");
    const statusEl = page.querySelector("#tabzStatus");
    const buttons = page.querySelectorAll(".tabz-action");
    const listEl = page.querySelector("#tabzList");
    const input = page.querySelector("#tabzInput");
    const addBtn = page.querySelector("#tabzAddBtn");

    let statusTimer = null;

    function refreshCount() {
      chrome.tabs.query({}, (tabs) => {
        countEl.textContent = tabs.length;
      });
    }

    function setBusy(busy) {
      buttons.forEach((b) => (b.disabled = busy));
    }

    function showStatus(text, kind) {
      clearTimeout(statusTimer);
      statusEl.textContent = text;
      statusEl.className = "tabz-status " + (kind || "");
      if (kind !== "loading") {
        statusTimer = setTimeout(() => {
          statusEl.textContent = "";
          statusEl.className = "tabz-status";
        }, 4000);
      }
    }

    const ops = {
      removeDuplicates: { fn: removeDuplicateTabs, busy: "Removing duplicates…" },
      moveUngrouped: { fn: moveUngroupedTabs, busy: "Moving tabs…" },
      sortTabs: { fn: sortTabsByDomain, busy: "Sorting tabs…" },
      exportUrls: { fn: exportTabUrls, busy: "Copying URLs…" },
    };

    async function runOp(name) {
      const op = ops[name];
      if (!op) return;
      setBusy(true);
      showStatus(op.busy, "loading");
      try {
        const msg = await op.fn();
        showStatus(msg, "success");
      } catch (err) {
        showStatus(err.message || "Something went wrong", "error");
      } finally {
        setBusy(false);
        refreshCount();
      }
    }

    buttons.forEach((btn) =>
      btn.addEventListener("click", () => runOp(btn.dataset.op))
    );

    // ── Whitelist rendering ──
    async function renderList() {
      const domains = await getDomains();
      listEl.innerHTML = "";
      if (!domains.length) {
        const empty = document.createElement("div");
        empty.className = "tabz-empty";
        empty.textContent = "No whitelisted domains";
        listEl.appendChild(empty);
        return;
      }
      for (const domain of domains) {
        const item = document.createElement("div");
        item.className = "tabz-item";
        const span = document.createElement("span");
        span.textContent = domain;
        const rm = document.createElement("button");
        rm.textContent = "×";
        rm.title = "Remove";
        rm.addEventListener("click", async () => {
          const list = (await getDomains()).filter((d) => d !== domain);
          await setDomains(list);
          renderList();
        });
        item.appendChild(span);
        item.appendChild(rm);
        listEl.appendChild(item);
      }
    }

    async function addDomain() {
      let domain = input.value.trim().toLowerCase();
      if (!domain) return;
      try {
        if (domain.includes("://")) domain = new URL(domain).hostname;
      } catch {
        // fall through with raw input
      }
      domain = domain.replace(/^www\./, "");

      if (!isValidDomain(domain)) {
        showStatus('Invalid domain — use e.g. "example.com"', "error");
        return;
      }
      const list = await getDomains();
      if (list.includes(domain)) {
        showStatus(`"${domain}" is already whitelisted`, "error");
        return;
      }
      list.push(domain);
      await setDomains(list);
      input.value = "";
      renderList();
    }

    addBtn.addEventListener("click", addDomain);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addDomain();
    });

    // Refresh the tab count whenever the tAbZ nav button is clicked
    const navBtn = document.querySelector('.nav button[data-page="tabz"]');
    if (navBtn) navBtn.addEventListener("click", refreshCount);

    refreshCount();
    renderList();
  }

  // ── Injected styles (SuperLevels palette, tabz- namespaced) ──
  function injectStyles() {
    if (document.getElementById("tabz-styles")) return;
    const css = `
      .tabz-count {
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 12px; margin-bottom: 12px;
        background: #16213e; border-radius: 8px; font-size: 13px;
      }
      .tabz-count b { color: #e0e0e0; }
      .tabz-count .num {
        font-size: 12px; color: #aaa;
        background: #0f3460; padding: 2px 10px; border-radius: 10px;
      }
      .tabz-actions { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
      .tabz-action {
        display: flex; align-items: center; gap: 10px;
        width: 100%; padding: 11px 12px; text-align: left;
        background: #16213e; color: #e0e0e0;
        border: 1px solid #2a2a4a; border-radius: 8px;
        font-size: 13px; font-weight: 600; cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
      }
      .tabz-action:hover:not(:disabled) { background: #1b2a4a; border-color: #e94560; }
      .tabz-action:disabled { opacity: 0.5; cursor: default; }
      .tabz-action .ico { font-size: 16px; flex-shrink: 0; }
      .tabz-status { font-size: 12px; min-height: 16px; margin: 10px 0 4px; text-align: center; }
      .tabz-status.loading { color: #aaa; }
      .tabz-status.success { color: #4caf50; }
      .tabz-status.error { color: #e94560; }
      .tabz-add {
        display: flex; gap: 6px; margin-bottom: 10px;
      }
      .tabz-add input {
        flex: 1; padding: 7px 10px;
        border: 1px solid #333; border-radius: 6px;
        background: #0f3460; color: #fff; font-size: 13px;
      }
      .tabz-add input::placeholder { color: #666; }
      .tabz-add input:focus { outline: none; border-color: #e94560; }
      .tabz-add button {
        padding: 7px 14px; background: #e94560; color: #fff;
        border: none; border-radius: 6px;
        font-size: 13px; font-weight: 600; cursor: pointer;
      }
      .tabz-add button:hover { background: #c73650; }
      .tabz-item {
        display: flex; align-items: center; justify-content: space-between;
        padding: 6px 10px; background: #16213e;
        border-radius: 6px; margin-bottom: 4px; font-size: 13px;
      }
      .tabz-item span { word-break: break-all; }
      .tabz-item button {
        background: none; border: none; color: #e94560;
        font-size: 16px; cursor: pointer; padding: 0 4px; line-height: 1;
      }
      .tabz-item button:hover { color: #ff6b81; }
      .tabz-empty { color: #555; font-size: 12px; text-align: center; padding: 12px; }
      .tabz-note {
        color: #666; font-size: 11px; line-height: 1.5;
        margin-top: 12px; padding-top: 10px; border-top: 1px solid #2a2a4a;
      }
    `;
    const style = document.createElement("style");
    style.id = "tabz-styles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
