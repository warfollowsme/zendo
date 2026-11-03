// ==UserScript==
// @name           Minimal folder icons
// @description    Folders in the tabs panel get minimal closed/open icons (Lucide); a custom folder icon still shows inside
// ==/UserScript==

// Zen draws a folder with an inline SVG (nsZenFolder.rawIcon): back and front
// walls, an .icon slot with the user-chosen icon, and .dots for a
// collapsed folder with an active tab. We swap in minimalist Lucide shapes
// (folder / folder-open, https://lucide.dev, ISC), keeping .icon and
// .dots: Zen itself sets state="open|close" and active="true|false" on the svg and
// puts the icon into "svg .icon image". Styles: CSS/folder-icons.uc.css.
(function () {
  if (!window.gBrowser || window.kitFolderIcons) {
    return;
  }
  window.kitFolderIcons = true;

  // Shape like Arc folders: closed is an outline with a tab; open is the same
  // back wall plus a front wall tilted forward. The back wall under the front one
  // isn't filled with background (a rectangle would show on a selected tab) but
  // cut out with the kit-folder-cut mask. viewBox with margins: folder ~17px, like tab icons.
  const FRONT = "M5.3 11.2H21.6a1.3 1.3 0 0 1 1.24 1.7l-1.9 5.9A1.8 1.8 0 0 1 19.2 20H3.5a1.3 1.3 0 0 1-1.24-1.7l1.9-5.9A1.8 1.8 0 0 1 5.3 11.2Z";
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="-4 -4 32 32" fill="none" class="kit-folder-svg">
    <mask id="kit-folder-cut" maskUnits="userSpaceOnUse" x="-4" y="-4" width="32" height="32">
      <rect x="-4" y="-4" width="32" height="32" fill="white"/>
      <path class="kit-folder-cut-front" d="${FRONT}" fill="black" stroke="black" stroke-width="3"/>
    </mask>
    <path class="kit-folder-back" mask="url(#kit-folder-cut)" d="M4 4.5H8.6a1.6 1.6 0 0 1 1.2.55L11 6.4a1.6 1.6 0 0 0 1.2.55H20a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z"/>
    <path class="kit-folder-front" d="${FRONT}"/>
    <mask id="kit-folder-mask" style="mask-type: alpha"><g class="icon"><image href="" x="7.5" y="9" width="9" height="9"/></g></mask>
    <rect class="kit-folder-icon-fill" x="7.5" y="9" width="9" height="9" mask="url(#kit-folder-mask)"/>
    <g class="dots"><circle cx="8" cy="13.5" r="1.1"/><circle cx="12" cy="13.5" r="1.1"/><circle cx="16" cy="13.5" r="1.1"/></g>
  </svg>`;
  // The user's icon is a mask over a rectangle painted in the text
  // color (context-fill doesn't reach an image inside an SVG, so it came out black).
  // Zen fades .icon (opacity) on a collapsed folder with an active tab, and the mask fades too.
  // Each folder gets its own masks: a shared id would give all of them the first folder's icon.
  let maskCount = 0;
  const uniqueMask = svg => {
    const n = ++maskCount;
    for (const mask of svg.querySelectorAll("mask")) {
      const base = mask.id.replace(/-\d+$/, "");
      const id = `${base}-${n}`;
      for (const user of svg.querySelectorAll(`[mask="url(#${mask.id})"]`)) {
        user.setAttribute("mask", `url(#${id})`);
      }
      mask.id = id;
    }
  };
  const fresh = () => new DOMParser().parseFromString(SVG, "image/svg+xml").documentElement;

  function swap(folder) {
    const old = folder.icon?.querySelector("svg");
    if (!old) {
      return;
    }
    if (old.classList.contains("kit-folder-svg")) {
      uniqueMask(old); // rawIcon copy in a new folder
      return;
    }
    const svg = fresh();
    const href = old.querySelector(".icon image")?.getAttribute("href");
    if (href) {
      svg.querySelector(".icon image").setAttribute("href", href);
    }
    uniqueMask(svg);
    old.replaceWith(svg);
    try {
      window.gZenFolders?.updateFolderIcon(folder); // restore state/active
    } catch (e) {
      console.error("folder-icons:", e);
    }
  }

  customElements.whenDefined("zen-folder").then(() => {
    const Folder = customElements.get("zen-folder");
    // new folders take their icon from here; after insertion give it its own mask
    Folder.rawIcon = fresh();
    const connected = Folder.prototype.connectedCallback;
    Folder.prototype.connectedCallback = function () {
      connected.call(this);
      swap(this);
    };
    // already created ones (restored at startup): replace
    for (const folder of document.querySelectorAll("zen-folder")) {
      swap(folder);
    }
  });
})();
