// ==UserScript==
// @name           Extensions side panel
// @description    Open extension popups and pin, enable, disable or remove extensions from a side panel
// ==/UserScript==
(function () {
  if (!window.gBrowser || window.kitExtensionsRegistered) return;
  window.kitExtensionsRegistered = true;

  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const { BasePopup } = ChromeUtils.importESModule("resource:///modules/ExtensionPopups.sys.mjs");
  const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
  const HTML = "http://www.w3.org/1999/xhtml";
  let body, list, host, back, status, popup, search, query = "";
  let generation = 0;
  let refreshGeneration = 0;
  const busyAddons = new Set();
  let visible = false;
  const el = (tag, id, text) => {
    const node = document.createElementNS(HTML, tag);
    node.id = `kit-extensions-${id}`;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // Use the built-in WebExtension browser: processes, principal, popup API,
  // window.close() and activeTab work the same as with a regular extension button.
  // Only the container and sizing are replaced: our island instead of a popup menu.
  class SidePopup extends BasePopup {
    get panel() { return this.viewNode; }
    get DESTROY_EVENT() { return "kit-extension-destroy"; }
    resizeBrowser() {} // The panel sets the size, not the popup content.
    setBackground(background) {
      super.setBackground(background);
      if (this.viewNode) this.viewNode.style.backgroundColor = this.background;
    }
    closePopup() { showList(); }
  }

  function report(error) {
    console.error("kit-extensions:", error);
    if (status) status.textContent = `Extension action failed: ${error.message}`;
  }

  function closePopup() {
    generation++;
    const old = popup;
    popup = null;
    if (old && !old.destroyed) old.destroy().catch(report);
  }

  function showList() {
    closePopup();
    if (!body) return;
    list.hidden = false;
    search.hidden = false;
    host.hidden = true;
    back.hidden = true;
    status.textContent = "";
    refresh().catch(report);
  }

  async function openExtension(extension, action, optionsURL) {
    closePopup();
    const token = generation;
    status.textContent = "";
    try {
      // triggerClickOrPopup itself grants activeTab only on an explicit click,
      // respects action restrictions on the current tab and calls onClicked
      // if the extension has no popup.
      const url = action
        ? action.action.triggerClickOrPopup(gBrowser.selectedTab, { button: 0, modifiers: [] })
        : optionsURL;
      if (!url) {
        status.textContent = action
          ? "This extension has no popup here. Its action was invoked if available."
          : "This extension has no popup or settings page.";
        return;
      }
      const existing = BasePopup.for(extension, window);
      if (existing && !existing.destroyed) await existing.destroy();
      if (token !== generation || !visible) return;
      list.hidden = true;
      search.hidden = true;
      host.hidden = false;
      back.hidden = false;
      host.setAttribute("aria-label", extension.name);
      const current = new SidePopup(extension, host, url, action?.browserStyle ?? false, true);
      popup = current;
      await current.browserReady;
      if (token !== generation || current.destroyed) return;
      current.browser.dispatchEvent(new CustomEvent("WebExtPopupLoaded", {
        bubbles: true, detail: { extension },
      }));
      current.browser.focus();
    } catch (error) {
      showList();
      report(error);
    }
  }

  function iconButton(id, title, icon, command) {
    const button = el("button", id);
    button.type = "button";
    button.className = "kit-icon-button kit-mask-icon kit-extensions-control";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.style.setProperty("--kit-icon", `url("chrome://browser/skin/zen-icons/${icon}.svg")`);
    button.addEventListener("click", command);
    return button;
  }

  async function runAddonCommand(addon, command) {
    if (busyAddons.has(addon.id)) return;
    busyAddons.add(addon.id);
    status.textContent = "";
    try {
      await refresh();
      await command();
    } catch (error) {
      report(error);
    } finally {
      busyAddons.delete(addon.id);
      refresh().catch(report);
    }
  }

  async function refresh() {
    if (!body || !visible || popup) return;
    const token = generation;
    const revision = ++refreshGeneration;
    const addons = await AddonManager.getAddonsByTypes(["extension"]);
    if (revision !== refreshGeneration || token !== generation || !visible || popup) return;
    list.replaceChildren();
    const installed = addons.filter(a => !a.isSystem && !a.hidden);
    const matching = installed.filter(a => !query || a.name.toLowerCase().includes(query));
    for (const addon of matching.sort((a, b) => a.name.localeCompare(b.name))) {
      const extension = ExtensionParent.GlobalManager.extensionMap.get(addon.id);
      const allowed = extension && (!PrivateBrowsingUtils.isWindowPrivate(window) || extension.privateBrowsingAllowed);
      const action = extension && ExtensionParent.apiManager.global.browserActionFor(extension);
      const id = encodeURIComponent(addon.id);
      const busy = busyAddons.has(addon.id);
      const row = el("div", `addon-${id}`);
      row.className = "kit-extensions-row kit-extensions-addon";
      const open = el("button", `open-${id}`);
      open.type = "button";
      open.className = "kit-button kit-extensions-open";
      open.disabled = busy || !addon.isActive || !allowed;
      const image = el("img", `icon-${id}`);
      image.src = addon.iconURL || "chrome://browser/skin/zen-icons/extension.svg";
      image.alt = "";
      const name = el("span", `name-${id}`, addon.name);
      open.append(image, name);
      open.title = !addon.isActive || !allowed ? `${addon.name} — unavailable or disabled` : addon.name;
      open.addEventListener("click", () => openExtension(extension, action, addon.optionsURL));

      const widgetId = action?.id;
      const placement = widgetId && CustomizableUI.getPlacementOfWidget(widgetId);
      const pinned = !!placement && placement.area !== CustomizableUI.AREA_ADDONS;
      const pin = iconButton(`pin-${id}`, pinned ? "Unpin from toolbar" : "Pin to toolbar", "pin", () => {
        void runAddonCommand(addon, async () => {
          if (!pinned) gUnifiedExtensions._maybeMoveWidgetNodeBack(widgetId);
          await gUnifiedExtensions.pinToToolbar(widgetId, !pinned);
        });
      });
      pin.setAttribute("aria-pressed", String(pinned));
      pin.disabled = busy || !widgetId || !allowed;

      const disabled = !!addon.userDisabled;
      const toggle = iconButton(`toggle-${id}`, disabled ? "Enable extension" : "Disable extension",
        disabled ? "extension" : "extension-blocked", () => {
          void runAddonCommand(addon, () => disabled ? addon.enable() : addon.disable());
        });
      toggle.disabled = busy || !(addon.permissions & (disabled
        ? AddonManager.PERM_CAN_ENABLE : AddonManager.PERM_CAN_DISABLE));
      const remove = iconButton(`remove-${id}`, "Remove extension", "trash", () => {
        // Built-in uninstall dialog, including the permission check and confirmation.
        void runAddonCommand(addon, () => BrowserAddonUI.removeAddon(addon.id));
      });
      remove.disabled = busy || !(addon.permissions & AddonManager.PERM_CAN_UNINSTALL);
      row.append(open, pin, toggle, remove);
      list.append(row);
    }
    if (!list.childElementCount) {
      list.append(el("p", "empty", installed.length ? "No matching extensions." : "No extensions installed."));
    }
  }

  // Search and "Get more" in the Zen Library header style (as in the Boosts panel:
  // the same zen-library-search-* classes, with the store on the right instead of Filters).
  function searchHeader() {
    const top = el("div", "search");
    top.className = "zen-library-search-top";
    const header = document.createElementNS(HTML, "div");
    header.className = "zen-library-search-header";
    const box = document.createElementNS(HTML, "div");
    box.className = "zen-library-search-box";
    const glass = document.createElementNS(HTML, "img");
    glass.src = "chrome://browser/skin/zen-icons/search-glass.svg";
    glass.alt = "";
    const input = el("input", "search-input");
    input.type = "search";
    input.placeholder = "Search extensions";
    input.addEventListener("input", () => {
      query = input.value.trim().toLowerCase();
      refresh().catch(report);
    });
    box.append(glass, input);
    const store = el("button", "store");
    store.type = "button";
    store.className = "zen-library-filter-button";
    store.title = "Open addons.mozilla.org";
    store.append(document.createTextNode("Get more ↗"));
    store.addEventListener("click", () => {
      window.openTrustedLinkIn("https://addons.mozilla.org/firefox/extensions/", "tab");
    });
    header.append(box, store);
    top.append(header);
    return top;
  }

  // Keep pin in sync with changes from the built-in menu or another window too.
  const widgetListener = {
    onWidgetAdded() { refresh().catch(report); },
    onWidgetRemoved() { refresh().catch(report); },
    onWidgetMoved() { refresh().catch(report); },
  };
  const addonListener = {
    onInstalled() { if (visible) showList(); },
    onUninstalled() { if (visible) showList(); },
    onEnabled() { if (visible) showList(); },
    onDisabled() { if (visible) showList(); },
  };
  (window.kitLayoutQueue ??= []).push({
    id: "extensions", title: "Extensions", icon: "extension", zone: "right-bottom",
    create(container, { actions }) {
      if (document.getElementById("kit-extensions-list")) return;
      body = container;
      body.classList.add("kit-extensions-body");
      back = el("button", "back", "← Back");
      back.className = "kit-button";
      back.hidden = true;
      back.addEventListener("click", showList);
      actions.append(back);
      search = searchHeader();
      list = el("div", "list");
      host = el("div", "host");
      host.hidden = true;
      status = el("div", "status");
      status.setAttribute("role", "status");
      body.append(search, list, host, status);
      AddonManager.addAddonListener(addonListener);
      CustomizableUI.addListener(widgetListener);
    },
    onShow() { visible = true; showList(); },
    onHide() { visible = false; closePopup(); },
  });
  const tabChanged = () => { if (visible) showList(); };
  gBrowser.tabContainer.addEventListener("TabSelect", tabChanged);
  window.addEventListener("unload", () => {
    visible = false;
    closePopup();
    AddonManager.removeAddonListener(addonListener);
    CustomizableUI.removeListener(widgetListener);
    gBrowser.tabContainer.removeEventListener("TabSelect", tabChanged);
  }, { once: true });
})();
