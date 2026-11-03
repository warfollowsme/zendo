// ==UserScript==
// @name           Link split
// @description    Links a page opens in a new tab or window open in split view to the right of the page
// ==/UserScript==

// Ссылка, которую страница открывает в новой вкладке (target=_blank,
// window.open), встаёт справа от страницы в разделённом экране Zen.
//
// Отличаем по событию TabOpen: у вкладок, которые открыла страница, Firefox
// пишет в detail fromExternal: false, у внешних ссылок (из мессенджеров) —
// true, а у открытых из интерфейса (пункты меню ссылки, Cmd+клик, адресная
// строка) этого поля нет. Поэтому меню работает как написано: «Open Link in
// New Tab» — вкладка, «Open Link in Glance» — превью, внешние ссылки — вкладка.
// Делит тем же gZenViewSplitter.splitTabs, что и «Split Link to New Tab»;
// если в разделённом экране уже 4 панели, ссылка остаётся вкладкой. Ссылка из
// закреплённой вкладки тоже закрепляется (иначе Zen делит копию страницы).
// Выключить: about:config → kit.links.split = false.
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
      owner.hasAttribute("zen-glance-tab") || // ссылка из превью — обычной вкладкой
      tab.pinned ||
      PrivateBrowsingUtils.isWindowPrivate(window)
    ) {
      return;
    }
    // Zen мог уже открыть её в Glance сам (ссылки из essential-вкладок) —
    // проверяем после того, как он закончит с открытием вкладки.
    setTimeout(() => {
      if (!tab.isConnected || tab.hasAttribute("glance-id") || !owner.isConnected) {
        return;
      }
      // Из essential-вкладок и живых папок Zen делит только копию страницы —
      // такие ссылки остаются обычной вкладкой.
      if (owner.hasAttribute("zen-essential") || owner.hasAttribute("zen-live-folder-item-id")) {
        return;
      }
      try {
        // Закреплённую вкладку с незакреплённой Zen делит, подставляя копию
        // страницы (она грузится заново и остаётся лишней вкладкой). Закрепляем
        // ссылку — тогда делится сама вкладка, как сплит в Arc.
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
