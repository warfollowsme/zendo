// ==UserScript==
// @name           Link split
// @description    Links a page opens in a new tab or window open in split view to the right of the page
// ==/UserScript==

// A link the page opens in a new tab (target=_blank,
// window.open) is placed to the right of the page in a Zen split view.
//
// We tell them apart by the TabOpen event: for tabs opened by the page Firefox
// sets detail fromExternal: false, for external links (from messengers)
// true, and for tabs opened from the UI (link menu items, Cmd+click, URL
// bar) the field is absent. So the menu works as labeled: "Open Link in
// New Tab" opens a tab, "Open Link in Glance" a preview, external links a tab.
// Splits with the same gZenViewSplitter.splitTabs as "Split Link to New Tab";
// if the split view already has 4 panes, the link stays a tab. A link from
// a pinned tab is pinned too (otherwise Zen splits a copy of the page).
// To disable: about:config → kit.links.split = false.
(function () {
  if (!window.gBrowser || window.kitLinkSplit) {
    return;
  }
  window.kitLinkSplit = true;
  const PREF = "kit.links.split";

  gBrowser.tabContainer.addEventListener("TabOpen", event => {
    const tab = event.target;
    const owner = tab.owner;
    if (
      event.detail?.fromExternal !== false ||
      !Services.prefs.getBoolPref(PREF, true) ||
      !window.gZenViewSplitter ||
      !owner ||
      owner.hasAttribute("zen-glance-tab") || // link from a preview opens as a regular tab
      tab.pinned ||
      PrivateBrowsingUtils.isWindowPrivate(window)
    ) {
      return;
    }
    // Zen may have already opened it in Glance itself (links from essential tabs),
    // so check after it's done opening the tab.
    setTimeout(() => {
      if (!tab.isConnected || tab.hasAttribute("glance-id") || !owner.isConnected) {
        return;
      }
      // From essential tabs and live folders Zen only splits a copy of the page,
      // so such links stay regular tabs.
      if (owner.hasAttribute("zen-essential") || owner.hasAttribute("zen-live-folder-item-id")) {
        return;
      }
      try {
        // When splitting a pinned tab with an unpinned one, Zen substitutes a copy
        // of the page (it reloads and remains as an extra tab). We pin the
        // link, so the tab itself is split, like a split in Arc.
        if (owner.pinned && !tab.pinned) {
          gBrowser.pinTab(tab);
        }
        gZenViewSplitter.splitTabs([owner, tab], "vsep", 1);
      } catch (e) {
        console.error("link-split:", e);
      }
    }, 0);
  });
})();
