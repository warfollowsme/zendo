// ==UserScript==
// @name           Copy as Markdown
// @description    Tab context menu item: copies the link as [title](url)
// ==/UserScript==

// Example fx-autoconfig script. Works only after
// `bin/install --autoconfig` has been run. The script runs once per browser window.
(function () {
  const menu = document.getElementById("tabContextMenu");
  if (!menu || document.getElementById("kit-copy-md-link")) {
    return;
  }

  const item = document.createXULElement("menuitem");
  item.id = "kit-copy-md-link";
  item.setAttribute("label", "Copy as Markdown");

  item.addEventListener("command", () => {
    try {
      const tab = TabContextMenu.contextTab || gBrowser.selectedTab;
      const browser = tab.linkedBrowser;
      const url = browser.currentURI.spec;
      const title = (tab.label || url).replace(/[\[\]]/g, "");
      Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Ci.nsIClipboardHelper)
        .copyString(`[${title}](${url})`);
    } catch (e) {
      console.error("copy-md-link:", e);
    }
  });

  menu.appendChild(item);
})();
