// ==UserScript==
// @name           Address bar: site title
// @description    While the address bar is not being edited, it shows the page title instead of the URL; click to edit the URL
// ==/UserScript==

// Поверх поля адреса — подпись с заголовком страницы. Видна, пока строка не в
// фокусе и в ней адрес текущей страницы (pageproxystate="valid"); при клике
// подпись прячется, и поле с адресом выделяется как обычно. Стили —
// CSS/urlbar-title.uc.css.
(function () {
  const box = document.querySelector("#urlbar .urlbar-input-box");
  if (!window.gBrowser || !box || document.getElementById("kit-urlbar-title")) {
    return;
  }
  const title = document.createElementNS("http://www.w3.org/1999/xhtml", "span");
  title.id = "kit-urlbar-title";
  box.append(title);

  const update = () => {
    const tab = gBrowser.selectedTab;
    const url = tab.linkedBrowser.currentURI?.spec || "";
    const label = tab.label || "";
    // у пустых и служебных страниц заголовка нет или он равен адресу — оставляем адрес
    const show = label && label !== url && !/^about:(blank|newtab|home)$/.test(url);
    title.textContent = show ? label : "";
    box.toggleAttribute("kit-has-title", !!show);
  };

  gBrowser.tabContainer.addEventListener("TabSelect", update);
  gBrowser.tabContainer.addEventListener("TabAttrModified", e => e.target === gBrowser.selectedTab && update());
  gBrowser.addTabsProgressListener({
    onLocationChange: browser => browser === gBrowser.selectedBrowser && update(),
  });
  update();
})();
