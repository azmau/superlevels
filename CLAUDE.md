# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SuperLevels is a Manifest V3 Chrome extension (by levelsio) that bundles ~15 small features (dark mode, cookie-banner dismisser, tab cleaner, YouTube/X unhook, X dim theme, JSON formatter, PiP, archive.is redirect, AI summarize, etc.) into one package. It is plain vanilla JavaScript: **no build step, no package.json, no dependencies, no tests, no linter.**

## Running / testing

- Load it unpacked: `chrome://extensions` → Developer mode → **Load unpacked** → select this folder.
- After editing, click the reload icon on the extension card. Content-script changes also need a reload of the target page, and the popup has to be reopened.
- You can only verify behavior by hand, in the browser, on the sites a feature targets. Check a `manifest.json` edit by parsing it, for example `python -c "import json;json.load(open('manifest.json',encoding='utf-8'))"`.

## Architecture

There are three execution contexts, and they talk to each other only through `chrome.storage.local` and messages:

1. **Popup** (`popup.html` + `popup.js`): one large single-page UI. A vertical `.nav` of `<button data-page="X">` entries switches between `<div class="page" id="page-X">` panels. `switchToPage()` in `popup.js` shows the panel, calls that feature's `loadX()` function (an `if/else` chain keyed by page name), and stores `last_tab`. Each feature is a section of `popup.js` marked by a `// ═══` banner comment.
2. **Content scripts** (one file per feature, wired up in `manifest.json` `content_scripts` with match patterns and `run_at`). Each one is an IIFE that:
   - reads its `<feature>_enabled` key (plus any settings) from `chrome.storage.local` at startup,
   - applies itself mostly by injecting a `<style id="sl-...">` tag, plus a `MutationObserver` for SPAs,
   - listens on `chrome.runtime.onMessage` for a `{ type: "<feature>_toggle", enabled, ... }` message so changes apply live without a reload.
3. **Service worker** (`background.js`): handles the tab-cleaner alarm and inactivity tracking, redirect-chain capture via `webRequest` (`getRedirects` message), PiP injection via `chrome.scripting.executeScript` (`pip` message), and the No Paywall redirect in `webNavigation.onBeforeNavigate`, driven by `archive_enabled` / `archive_sites`. It also handles **dynamic MAIN-world registration** of `photopea-main.js` with `chrome.scripting.registerContentScripts`. That script has to run in the page world before Photopea's own scripts, so it is registered or unregistered whenever `photopea_enabled` changes and is not listed in the manifest.

**Toggle flow (the standard pattern for a feature):** the popup checkbox writes `chrome.storage.local.set({ <feature>_enabled })`, then calls `chrome.tabs.sendMessage(activeTab, { type: "<feature>_toggle", enabled })` with `.catch(() => {})`, and the content script updates live. A few scripts (`xdim.js`, the background worker) use `chrome.storage.onChanged` instead.

**Adding a feature** therefore touches: a new content-script file, a `manifest.json` entry (plus permissions if needed), a nav button and a page `<div>` in `popup.html`, and a section in `popup.js` plus a branch in `switchToPage()`. The manifest `description` and `README.md` also list every feature.

Storage keys are flat and prefixed per feature (`darkmode_global`, `darkmode_<host>`, `livecss_<host>`, `xdim_theme`, `unhook_features`, `closed_tabs`, `music_history`, …). User-supplied API keys (ACRCloud for Music, OpenAI/Anthropic/xAI for Summarize) live in `chrome.storage.local`, and the popup calls those APIs directly. Apart from those user-triggered calls, the extension makes no network requests. The README's privacy section promises this, so keep it that way.

## This fork

`origin` = `azmau/superlevels` (the user's fork), `upstream` = `levelsio/superlevels`. Sync with `git fetch upstream && git merge upstream/main`, then push to `origin`. Never push to upstream.

Personal features are kept **merge-safe against upstream**:
- Put the logic in a new isolated file that upstream will never touch. `tabz.js` is the template: a popup script loaded with its own `<script>` tag after `popup.js`. It self-initializes on `DOMContentLoaded`, injects its own `tabz-`-namespaced CSS, and stores data under namespaced keys (`tabz_domainList` in `chrome.storage.sync`).
- Keep edits to shared files (`manifest.json`, `popup.html`, `popup.js`, `background.js`) minimal and additive. Prefer not touching `popup.js`/`background.js` at all. `switchToPage()` already shows any `data-page` panel, even without a `loadX()` branch.
- `manifest.json`'s `description`/`permissions` lines conflict on most upstream merges. Resolve by taking upstream's text and re-adding this fork's extra permissions (currently `tabGroups`).
