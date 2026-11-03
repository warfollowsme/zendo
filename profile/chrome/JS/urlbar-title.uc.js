// ==UserScript==
// @name           Address bar: site title
// @description    While the address bar is not being edited, it shows the page title instead of the URL; click to edit the URL
// ==/UserScript==

// A caption with the page title over the address field. Visible while the bar isn't
// focused and holds the current page's address (pageproxystate="valid"); on click
// the caption hides and the address is selected as usual. Styles:
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
    // blank and internal pages have no title, or it equals the address: keep the address
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
