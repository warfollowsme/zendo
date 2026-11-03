// ==UserScript==
// @name           Layout: toolbars and side panels
// @description    Toolbars on the window edges with four tool zones and island side panels
// ==/UserScript==

// The window becomes a grid (styles in CSS/kit-layout.uc.css):
//
//   ┌─ traffic lights · spaces 1 2 3 · navigation and URL bar ────┐
//   │ toolbar │ left panel │     site     │ right panel │ toolbar │
//
// Each toolbar has two zones: top (icons run top to bottom) and bottom (bottom
// to top). Each zone has at most one tool open. A tool from the top zone takes
// the top of its side, one from the bottom zone the bottom; if only one tool is
// open on a side, it takes the full height. Icons can be dragged between zones.
//
// Tabs are Zen's own panel (#navigator-toolbox): we don't move it in the
// markup, only place it in the right grid cell.
//
// Other scripts add their tools like this (load order doesn't matter):
//   (window.kitLayoutQueue ??= []).push({ id, title, icon, zone, create(body) {…} });
// icon: Zen icon name ("settings" → chrome://browser/skin/zen-icons/settings.svg)
// or "library:<section>" for the animated icon of a Zen Library section,
// and control them via window.KitLayout.show(id) / hide(id) / toggle(id).
(function () {
  if (!window.gBrowser || document.getElementById("kit-strip-left")) {
    return;
  }

  const HTML = "http://www.w3.org/1999/xhtml";
  const PREF = "kit.layout.state";
  const ZONES = ["left-top", "left-bottom", "right-top", "right-bottom"];
  const ZEN_ICONS = "chrome://browser/skin/zen-icons/";
  const DEFAULT_STATE = {
    zones: {
      "left-top": ["tabs"],
      "left-bottom": ["settings", "develop"],
      "right-top": ["ai", "history", "bookmarks"],
      "right-bottom": ["downloads", "media", "boosts"],
    },
    active: { "left-top": "tabs", "left-bottom": null, "right-top": null, "right-bottom": null },
    width: { left: 280, right: 380 },
    split: { left: 0.6, right: 0.6 },
  };
  // Tools that no longer exist: drop them from the saved layout.
  const REMOVED_TOOLS = ["spaces"];

  const tools = new Map(); // id → tool definition
  const buttons = new Map(); // id → toolbar icon
  const panels = new Map(); // id → panel element in the grid
  const shown = new Set(); // id → tools whose panels are currently visible
  let state;
  let browserBox;
  let strips;
  let zoneEls;

  const el = (tag, cls, text) => {
    const node = document.createElementNS(HTML, tag);
    if (cls) {
      node.className = cls;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  };
  const iconUrl = icon => (icon.includes("://") ? icon : ZEN_ICONS + icon + ".svg");

  // Tool icon: a Zen icon via mask (color follows text) or the animated
  // sprite of a Library section, as on the Library's own sidebar.
  function fillIcon(node, icon) {
    if (icon.startsWith("library:")) {
      node.dataset.section = icon.slice(8);
      const clip = el("span", "kit-sprite");
      clip.append(el("span", "zen-library-tab-icon-image"));
      node.append(clip);
    } else {
      node.classList.add("kit-mask-icon");
      node.style.setProperty("--kit-icon", `url("${iconUrl(icon)}")`);
    }
  }

  function makeHeader(id, title) {
    const header = el("div", "kit-panel-header");
    const actions = el("span", "kit-panel-actions");
    const hide = el("button", "kit-icon-button kit-mask-icon");
    hide.title = "Hide";
    hide.style.setProperty("--kit-icon", `url("${iconUrl("close")}")`);
    hide.addEventListener("click", () => KitLayout.hide(id));
    header.append(el("span", "kit-panel-title", title), actions, hide);
    return { header, actions };
  }
  const sideOf = zone => zone.split("-")[0];
  const otherZone = zone => zone.replace(/top|bottom/, part => (part === "top" ? "bottom" : "top"));

  // ---------------------------------------------------------------- state

  function loadState() {
    let saved = {};
    try {
      saved = JSON.parse(Services.prefs.getStringPref(PREF, "{}"));
    } catch (e) {}
    const s = structuredClone(DEFAULT_STATE);
    for (const zone of ZONES) {
      if (Array.isArray(saved.zones?.[zone])) {
        s.zones[zone] = saved.zones[zone].filter(id => typeof id === "string" && !REMOVED_TOOLS.includes(id));
      }
      if (saved.active && zone in saved.active && !REMOVED_TOOLS.includes(saved.active[zone])) {
        s.active[zone] = saved.active[zone];
      }
    }
    Object.assign(s.width, saved.width);
    Object.assign(s.split, saved.split);
    // a tool not in any zone (new) goes to its default zone
    const placed = new Set(ZONES.flatMap(z => s.zones[z]));
    for (const zone of ZONES) {
      for (const id of DEFAULT_STATE.zones[zone]) {
        if (!placed.has(id)) {
          s.zones[zone].push(id);
          placed.add(id);
        }
      }
    }
    return s;
  }

  function saveState() {
    Services.prefs.setStringPref(PREF, JSON.stringify(state));
  }

  function zoneOf(id) {
    return ZONES.find(zone => state.zones[zone].includes(id)) || null;
  }

  // ---------------------------------------------------------------- tools

  function register(def) {
    if (!def?.id || tools.has(def.id)) {
      return;
    }
    tools.set(def.id, def);
    if (def.element) {
      // A ready-made element (Zen's tab panel) joins the layout right away, not
      // on first show: otherwise, while it's closed, the grid puts it in the first
      // free cell on top of the site or other panels.
      def.element.prepend(makeHeader(def.id, def.title).header);
      def.element.classList.add("kit-placed");
      panels.set(def.id, def.element);
    }
    if (!zoneOf(def.id)) {
      const zone = ZONES.includes(def.zone) ? def.zone : "right-top";
      state.zones[zone].push(def.id);
    }
    const button = el("button", "kit-tool-button");
    button.dataset.tool = def.id;
    button.title = def.title + (def.shortcut ? ` (${def.shortcut})` : "");
    fillIcon(button, def.icon);
    setupDrag(button, def.id);
    buttons.set(def.id, button);
    apply();
  }

  function panelFor(id) {
    if (panels.has(id)) {
      return panels.get(id);
    }
    const def = tools.get(id);
    let panel;
    if (def.element) {
      panel = def.element; // already prepared in register()
    } else {
      panel = document.createXULElement("vbox");
      panel.id = `kit-panel-${id}`;
      panel.className = "kit-panel";
      const { header, actions } = makeHeader(id, def.title);
      const body = document.createXULElement("vbox");
      body.className = "kit-panel-body";
      panel.append(header, body);
      browserBox.append(panel);
      try {
        def.create?.(body, { actions });
      } catch (e) {
        console.error(`kit-layout: tool ${id}:`, e);
        body.append(el("div", "kit-note", `Error: ${e.message}`));
      }
    }
    panel.classList.add("kit-placed");
    panels.set(id, panel);
    return panel;
  }

  // ---------------------------------------------------------------- layout

  function apply() {
    // icons by zone
    for (const zone of ZONES) {
      const list = state.zones[zone].filter(id => tools.has(id));
      zoneEls[zone].replaceChildren(...list.map(id => buttons.get(id)));
    }
    for (const [id, button] of buttons) {
      const active = state.active[zoneOf(id)] === id;
      if (active && !button.hasAttribute("active")) {
        // the Library sprite plays its animation on open, just like in Zen itself
        button.setAttribute("animate", "true");
        setTimeout(() => button.removeAttribute("animate"), 700);
      }
      button.toggleAttribute("active", active);
    }

    // which panels go where
    const open = id => id && tools.has(id);
    const nowShown = new Set();
    for (const id of tools.keys()) {
      const zone = zoneOf(id);
      const panel = state.active[zone] === id ? panelFor(id) : panels.get(id);
      if (!panel) {
        continue;
      }
      if (state.active[zone] === id) {
        const slot = open(state.active[otherZone(zone)]) ? zone : `${sideOf(zone)}-full`;
        panel.setAttribute("kit-slot", slot);
        nowShown.add(id);
      } else {
        panel.removeAttribute("kit-slot");
      }
    }

    // grid
    const sides = {};
    for (const side of ["left", "right"]) {
      const top = open(state.active[`${side}-top`]);
      const bottom = open(state.active[`${side}-bottom`]);
      sides[side] = { open: top || bottom, split: top && bottom };
      browserBox.toggleAttribute(`kit-${side}-open`, top || bottom);
      browserBox.toggleAttribute(`kit-${side}-split`, top && bottom);
    }
    const fl = clamp(state.split.left, 0.15, 0.85);
    const fr = clamp(state.split.right, 0.15, 0.85);
    const a = Math.min(fl, fr);
    const b = Math.max(fl, fr);
    const style = browserBox.style;
    style.setProperty("--kit-left-w", sides.left.open ? `${state.width.left}px` : "0px");
    style.setProperty("--kit-right-w", sides.right.open ? `${state.width.right}px` : "0px");
    style.setProperty("--kit-row-1", `${a}fr`);
    style.setProperty("--kit-row-2", `${b - a}fr`);
    style.setProperty("--kit-row-3", `${1 - b}fr`);
    style.setProperty("--kit-left-line", fl === a ? 3 : 4);
    style.setProperty("--kit-right-line", fr === a ? 3 : 4);

    // notify tools
    for (const id of nowShown) {
      if (!shown.has(id)) {
        tools.get(id).onShow?.();
      }
    }
    for (const id of shown) {
      if (!nowShown.has(id)) {
        tools.get(id)?.onHide?.();
      }
    }
    shown.clear();
    nowShown.forEach(id => shown.add(id));
    saveState();
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, Number(v) || 0.5));
  }

  // ---------------------------------------------------------------- icon dragging

  let drag = null;

  function setupDrag(button, id) {
    button.addEventListener("pointerdown", e => {
      if (e.button !== 0) {
        return;
      }
      drag = { id, button, x: e.clientX, y: e.clientY, started: false, target: null };
      button.setPointerCapture(e.pointerId);
    });
    button.addEventListener("pointermove", e => {
      if (!drag || drag.id !== id) {
        return;
      }
      if (!drag.started) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) {
          return;
        }
        startDrag();
      }
      moveDrag(e);
    });
    button.addEventListener("pointerup", () => {
      if (!drag || drag.id !== id) {
        return;
      }
      const d = drag;
      drag = null;
      if (d.started) {
        endDrag(d);
      } else {
        KitLayout.toggle(id);
      }
    });
    button.addEventListener("lostpointercapture", () => {
      if (drag?.id === id && drag.started) {
        const d = drag;
        drag = null;
        endDrag(d);
      }
    });
  }

  function startDrag() {
    drag.started = true;
    drag.button.setAttribute("dragging", "true");
    drag.ghost = drag.button.cloneNode(true);
    drag.ghost.classList.add("kit-drag-ghost");
    document.documentElement.append(drag.ghost);
    drag.marker = el("div", "kit-drop-marker");
    document.documentElement.append(drag.marker);
    document.documentElement.setAttribute("kit-dragging-tool", "true");
  }

  function moveDrag(e) {
    drag.ghost.style.left = e.clientX - 16 + "px";
    drag.ghost.style.top = e.clientY - 16 + "px";
    const side = e.clientX < window.innerWidth / 2 ? "left" : "right";
    const strip = strips[side];
    const rect = strip.getBoundingClientRect();
    const zone = `${side}-${e.clientY < rect.top + rect.height / 2 ? "top" : "bottom"}`;
    const others = state.zones[zone].filter(t => t !== drag.id && tools.has(t)).map(t => buttons.get(t));
    let index;
    let markerY;
    if (zone.endsWith("top")) {
      index = others.filter(b => centerY(b) < e.clientY).length;
      markerY = index < others.length ? others[index].getBoundingClientRect().top - 3 : others.length ? others.at(-1).getBoundingClientRect().bottom + 3 : rect.top + 6;
    } else {
      // the bottom zone grows from the bottom up
      index = others.filter(b => centerY(b) > e.clientY).length;
      markerY = index < others.length ? others[index].getBoundingClientRect().bottom + 3 : others.length ? others.at(-1).getBoundingClientRect().top - 3 : rect.bottom - 6;
    }
    drag.target = { zone, index };
    Object.assign(drag.marker.style, { left: rect.left + 6 + "px", width: rect.width - 12 + "px", top: markerY - 1 + "px" });
    for (const [z, node] of Object.entries(zoneEls)) {
      node.toggleAttribute("drop-target", z === zone);
    }
  }

  function centerY(node) {
    const r = node.getBoundingClientRect();
    return r.top + r.height / 2;
  }

  function endDrag(d) {
    d.button.removeAttribute("dragging");
    d.ghost?.remove();
    d.marker?.remove();
    document.documentElement.removeAttribute("kit-dragging-tool");
    Object.values(zoneEls).forEach(node => node.removeAttribute("drop-target"));
    if (!d.target) {
      return;
    }
    const from = zoneOf(d.id);
    const wasActive = state.active[from] === d.id;
    state.zones[from] = state.zones[from].filter(t => t !== d.id);
    // index was counted among registered icons; convert it to an index in the full list
    const list = state.zones[d.target.zone];
    const visible = list.filter(t => tools.has(t));
    const before = visible[d.target.index];
    list.splice(before ? list.indexOf(before) : list.length, 0, d.id);
    if (wasActive) {
      state.active[from] = null;
      state.active[d.target.zone] = d.id;
    }
    apply();
  }

  // ---------------------------------------------------------------- resizing

  function setupResizers() {
    for (const side of ["left", "right"]) {
      const width = el("div", `kit-resize kit-resize-width kit-resize-${side}`);
      width.addEventListener("pointerdown", e => {
        e.preventDefault();
        width.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        const start = state.width[side];
        const move = ev => {
          const delta = side === "left" ? ev.clientX - startX : startX - ev.clientX;
          state.width[side] = Math.round(Math.min(900, Math.max(200, start + delta)));
          apply();
        };
        width.addEventListener("pointermove", move);
        width.addEventListener("pointerup", () => width.removeEventListener("pointermove", move), { once: true });
      });
      const split = el("div", `kit-resize kit-resize-split kit-split-${side}`);
      split.addEventListener("pointerdown", e => {
        e.preventDefault();
        split.setPointerCapture(e.pointerId);
        const move = ev => {
          const rect = strips[side].getBoundingClientRect();
          state.split[side] = clamp((ev.clientY - rect.top) / rect.height, 0.15, 0.85);
          apply();
        };
        split.addEventListener("pointermove", move);
        split.addEventListener("pointerup", () => split.removeEventListener("pointermove", move), { once: true });
      });
      browserBox.append(width, split);
    }
  }

  // ---------------------------------------------------------------- API

  const KitLayout = {
    register,
    show(id) {
      const zone = zoneOf(id);
      if (zone && tools.has(id)) {
        state.active[zone] = id;
        apply();
      }
    },
    hide(id) {
      const zone = zoneOf(id);
      if (zone && state.active[zone] === id) {
        state.active[zone] = null;
        apply();
      }
    },
    toggle(id, force) {
      const zone = zoneOf(id);
      const isShown = state.active[zone] === id;
      (force ?? !isShown) ? KitLayout.show(id) : KitLayout.hide(id);
    },
    isShown: id => shown.has(id),
    reset() {
      Services.prefs.clearUserPref(PREF);
      state = loadState();
      for (const id of tools.keys()) {
        if (!zoneOf(id)) {
          state.zones[tools.get(id).zone || "right-top"].push(id);
        }
      }
      apply();
    },
  };

  // ---------------------------------------------------------------- built-in tools

  function pageTool(id, title, icon, src, zone) {
    return {
      id,
      title,
      icon,
      zone,
      create(body) {
        const frame = document.createXULElement("browser");
        frame.setAttribute("type", "chrome");
        frame.setAttribute("disablehistory", "true");
        frame.setAttribute("src", src);
        frame.className = "kit-panel-frame";
        body.append(frame);
      },
    };
  }

  // Zen Library sections (history, downloads, media, boosts) are
  // separate <zen-library-*-section> elements. We put them straight into a panel.
  // They need little from the Library itself: requestUpdate, keepOpenWhile and
  // constructor.toggle (close the library after opening a link), so we give a stub.
  let libraryHost = null;

  function getLibraryHost() {
    if (!libraryHost) {
      libraryHost = el("div");
      libraryHost.id = "kit-library-host";
      libraryHost.hidden = true;
      libraryHost.requestUpdate = () => {};
      libraryHost.keepOpenWhile = open => open();
      Object.defineProperty(libraryHost, "constructor", { value: { toggle() {} } });
      document.documentElement.append(libraryHost);
    }
    return libraryHost;
  }

  function librarySection(id, title, zone) {
    const name = id[0].toUpperCase() + id.slice(1);
    return {
      id,
      title,
      icon: `library:${id}`,
      zone,
      create(body, { actions }) {
        ChromeUtils.importESModule(`moz-src:///zen/library/sections/ZenLibrary${name}Section.mjs`, {
          global: "current",
        });
        const section = document.createElement(`zen-library-${id}-section`);
        section.className = "zen-library-section";
        section.dataset.section = id;
        section.library = getLibraryHost();
        body.classList.add("kit-library-body");
        body.append(section);
        if (id === "boosts") {
          window.KitLayoutPanels.boosts(body);
        } else if (id === "media") {
          window.KitLayoutPanels.media(body, actions);
        }
      },
    };
  }

  function builtinTools() {
    const toolbox = document.getElementById("navigator-toolbox");
    return [
      { id: "tabs", title: "Tabs", icon: "tab", zone: "left-top", element: toolbox },
      librarySection("history", "History", "right-top"),
      pageTool("bookmarks", "Bookmarks", "bookmark", "chrome://browser/content/places/bookmarksSidebar.xhtml", "right-top"),
      librarySection("downloads", "Downloads", "right-bottom"),
      librarySection("media", "Media", "right-bottom"),
      librarySection("boosts", "Boosts", "right-bottom"),
      { id: "settings", title: "Settings", icon: "settings", zone: "left-bottom", create: body => window.KitLayoutPanels.settings(body) },
      { id: "develop", title: "Develop", icon: "developer", zone: "left-bottom", create: body => window.KitLayoutPanels.develop(body) },
    ];
  }

  // ---------------------------------------------------------------- top bar and center

  // Zen spaces in the top bar, like Omarchy workspaces: a space with an icon
  // shows the icon, without one a number (the active one gets a dot).
  // All cells are the same size. Create Space at the end. Click to switch.
  function setupWorkspaces(box) {
    const ws = window.gZenWorkspaces;
    if (!ws || ws.privateWindowOrDisabled) {
      return;
    }
    const render = () => {
      const active = ws.activeWorkspace;
      const buttons = ws.getWorkspaces().map((space, i) => {
        const isActive = space.uuid === active;
        const b = el("button", "kit-workspace");
        const icon = space.icon || "";
        if (/^(chrome|data|moz-extension|https?):/.test(icon) || icon.endsWith(".svg")) {
          const img = document.createElementNS(HTML, "img");
          img.src = icon;
          img.className = "kit-workspace-icon";
          b.append(img);
        } else if (icon) {
          b.append(el("span", "kit-workspace-emoji", icon));
        } else {
          b.textContent = isActive ? "●" : String(i + 1);
        }
        b.toggleAttribute("active", isActive);
        b.title = space.name;
        b.addEventListener("click", () => ws.changeWorkspaceWithID(space.uuid));
        return b;
      });
      const create = el("button", "kit-workspace kit-workspace-create");
      create.title = "Create Space";
      create.addEventListener("click", () => {
        // Zen's creation form lives in the tab panel: show it beforehand.
        KitLayout.show("tabs");
        document.getElementById("cmd_zenOpenWorkspaceCreation")?.doCommand();
      });
      box.replaceChildren(...buttons, create);
    };
    window.addEventListener("ZenWorkspacesUIUpdate", render);
    window.addEventListener("ZenWorkspaceDataChanged", render);
    ws.addChangeListeners?.(render);
    render();
    setTimeout(render, 1000); // spaces may finish loading after startup
  }

  // Create Folder goes at the end of the folders section, above the Clear line. Not
  // directly into the section: Zen counts pinned tabs by its children
  // (dragging, session). It goes as the first row in the line's own container
  // (.pinned-tabs-container-separator), whose contents Zen doesn't count; the line
  // with Clear wraps to the next row (CSS).
  function setupCreateFolder() {
    const add = () => {
      for (const space of document.querySelectorAll("zen-workspace")) {
        const separator = space.querySelector(".zen-workspace-pinned-tabs-section > .pinned-tabs-container-separator");
        if (!separator || separator.querySelector(".kit-create-folder")) {
          continue;
        }
        const button = document.createXULElement("toolbarbutton");
        button.className = "kit-create-folder";
        button.setAttribute("label", "Create Folder");
        button.setAttribute("image", "chrome://browser/skin/zen-icons/folder.svg");
        button.addEventListener("command", () => document.getElementById("cmd_zenOpenFolderCreation")?.doCommand());
        separator.prepend(button);
      }
    };
    add();
    // new spaces and rebuilt space markup
    window.addEventListener("ZenWorkspacesUIUpdate", add);
    window.addEventListener("ZenWorkspaceDataChanged", add);
    const holder = document.querySelector("zen-workspace")?.parentNode;
    if (holder) {
      new MutationObserver(add).observe(holder, { childList: true });
    }
  }

  // Download animation: Zen flies the "file into downloads" toward the
  // Library button (#zen-library-button) or Firefox's downloads button, which we don't
  // have, so the file flew to the bottom corner of the window. Zen picks the target at
  // the start of initializeAnimation (synchronously, in a private method) via
  // getElementById; for that call we substitute the Downloads icon on our toolbar.
  function setupDownloadAnimationTarget() {
    customElements.whenDefined("zen-download-animation").then(() => {
      const proto = customElements.get("zen-download-animation").prototype;
      const original = proto.initializeAnimation;
      if (!original || proto.kitTargetPatched) {
        return;
      }
      proto.kitTargetPatched = true;
      proto.initializeAnimation = function (...args) {
        const target = buttons.get("downloads");
        const rect = target?.getBoundingClientRect();
        if (!rect?.width) {
          return original.apply(this, args); // icon not visible: behave like Zen
        }
        const doc = document;
        const getById = doc.getElementById;
        doc.getElementById = id => (id === "zen-library-button" ? target : getById.call(doc, id));
        try {
          return original.apply(this, args);
        } finally {
          delete doc.getElementById;
        }
      };
    });
  }

  // Page group (back/forward/reload, URL bar, zoom, full
  // screen, Split) is centered in the
  // window. CSS splits free space evenly (auto margins, see kit-layout.uc.css),
  // but spaces sit left of the group and other buttons right, with different widths,
  // so the group drifted. We measure by how much and compensate with bar padding.
  function setupNavBalance() {
    const target = document.getElementById("nav-bar-customization-target");
    let shift = 0;
    const update = () => {
      const first = document.getElementById("back-button");
      const last = ["kit-split", "fullscreen-button", "zoom-controls", "urlbar-container"]
        .map(id => document.getElementById(id))
        .find(e => e?.getBoundingClientRect().width);
      if (!target || !first?.getBoundingClientRect().width || !last) {
        return;
      }
      const center = (first.getBoundingClientRect().left + last.getBoundingClientRect().right) / 2;
      const next = Math.round(shift + (window.innerWidth / 2 - center));
      if (Math.abs(next - shift) < 1) {
        return;
      }
      shift = next;
      // padding of 2s on one side shifts a group with auto margins by s
      target.style.setProperty("--kit-nav-pad-start", `${Math.max(0, 2 * shift)}px`);
      target.style.setProperty("--kit-nav-pad-end", `${Math.max(0, -2 * shift)}px`);
    };
    const schedule = () => requestAnimationFrame(update);
    new ResizeObserver(schedule).observe(document.getElementById("kit-titlebar"));
    window.addEventListener("resize", schedule);
    setTimeout(schedule, 500);
    schedule();
  }

  // Zen places the expanded URL bar over the window with top: -2px, assuming it's
  // flush with the window top; we measure where the URL bar sits to correct it.
  function setupCenter(navbar) {
    const update = () => {
      const rect = navbar.getBoundingClientRect();
      browserBox.style.setProperty("--kit-navbar-top", `${Math.round(rect.top)}px`);
      // where the collapsed bar sits inside the URL bar strip, for the urlbar-dropdown mod,
      // so the expanded one stays exactly in place (Zen places it with top: -2px)
      const box = document.getElementById("urlbar-container")?.getBoundingClientRect();
      const height = parseFloat(getComputedStyle(document.getElementById("urlbar") || navbar).getPropertyValue("--urlbar-height"));
      if (box?.height && height) {
        browserBox.style.setProperty("--kit-urlbar-shift", `${box.top + (box.height - height) / 2 - rect.top + 2}px`);
      }
    };
    new ResizeObserver(update).observe(navbar);
    window.addEventListener("resize", update);
    update();
  }

  // Split the focused tab in two: side is right / left / top / bottom.
  // This is Zen's own split view (gZenViewSplitter): a new tab opens in the new
  // half, with the cursor in the URL bar. If the tab is already in a split
  // view, its own pane is split.
  const KitSplit = {
    canSplit() {
      const splitter = window.gZenViewSplitter;
      if (!splitter || !gBrowser.selectedTab) {
        return false;
      }
      const group = splitter._data.find(g => g.tabs.includes(gBrowser.selectedTab));
      return !group || group.tabs.length < splitter.MAX_TABS;
    },
    split(side) {
      if (!KitSplit.canSplit()) {
        return;
      }
      const splitter = window.gZenViewSplitter;
      const current = gBrowser.selectedTab;
      const group = splitter._data.find(g => g.tabs.includes(current));
      const tab = gBrowser.addTrustedTab(BROWSER_NEW_TAB_URL, { relatedToCurrent: true });
      if (!group) {
        const before = side === "left" || side === "top"; // new half comes first
        splitter.splitTabs(
          before ? [tab, current] : [current, tab],
          side === "left" || side === "right" ? "vsep" : "hsep",
          before ? 0 : 1
        );
      } else {
        if (current.group && tab.group !== current.group) {
          gBrowser.moveTabToExistingGroup(tab, current.group);
        }
        group.tabs.push(tab);
        const leaf = splitter.getSplitNodeFromTab(current);
        splitter.splitIntoNode(leaf, new leaf.constructor(tab, 50), side, 0.5);
        splitter.activateSplitView(group, true);
      }
      gBrowser.selectedTab = tab;
      setTimeout(() => gURLBar.select(), 150);
    },
  };

  // Close button in the split view pane's mini menu (shown on hover):
  // closes that pane's tab. Zen builds the mini menu in _createHeader;
  // we extend it, and also the ones already open.
  function setupSplitClose() {
    const splitter = window.gZenViewSplitter;
    if (!splitter?._createHeader) {
      return;
    }
    const addClose = (header, container) => {
      if (!header || header.querySelector(".kit-split-close")) {
        return;
      }
      const button = document.createXULElement("toolbarbutton");
      button.className = "kit-split-close";
      button.setAttribute("tooltiptext", "Close tab");
      button.addEventListener("click", () => {
        const browser = container.querySelector("browser");
        const tab = browser && gBrowser.getTabForBrowser(browser);
        if (tab) {
          gBrowser.removeTab(tab);
        }
      });
      header.append(button);
    };
    const original = splitter._createHeader.bind(splitter);
    splitter._createHeader = container => {
      const headerContainer = original(container);
      addClose(headerContainer.querySelector(".zen-view-splitter-header"), container);
      return headerContainer;
    };
    for (const header of document.querySelectorAll(".zen-view-splitter-header")) {
      addClose(header, header.closest(".browserSidebarContainer"));
    }
  }

  // Split button: a regular toolbar button (CustomizableUI, movable in Customize
  // Toolbar); click opens a menu: Add Right / Left / Top / Bottom Split.
  // Icon based on Material Symbols Light "add-column-left-outline-rounded":
  // a frame, a highlighted new column and a large plus (the original plus is small and
  // thin and was unreadable in the menu). Rotated toward the side of the new pane.
  const SPLIT_SIDES = [
    ["right", "Add Right Split"],
    ["left", "Add Left Split"],
    null,
    ["top", "Add Top Split"],
    ["bottom", "Add Bottom Split"],
  ];

  // On macOS the menu is native: it only draws the image from the image attribute
  // and ignores CSS (masks, background). The menu text color reaches the icon via
  // context-fill/context-stroke, which only works for chrome:// files.
  const splitIcon = side => `chrome://userchrome/content/kit-layout/icons/split-${side}.svg`;

  function setupSplitButtons() {
    if (!window.CustomizableUI) {
      return;
    }
    try {
      CustomizableUI.createWidget({
        id: "kit-split",
        label: "Split",
        tooltiptext: "Split the focused tab",
        defaultArea: CustomizableUI.AREA_NAVBAR,
      });
    } catch (e) {
      // already created in another window
    }

    const menu = document.createXULElement("menupopup");
    menu.id = "kit-split-menu";
    for (const item of SPLIT_SIDES) {
      if (!item) {
        menu.append(document.createXULElement("menuseparator"));
        continue;
      }
      const [side, label] = item;
      const entry = document.createXULElement("menuitem");
      entry.className = "menuitem-iconic";
      entry.setAttribute("label", label);
      entry.setAttribute("image", splitIcon(side));
      entry.addEventListener("command", () => KitSplit.split(side));
      menu.append(entry);
    }
    // Check the selected group on every open: after a pane is closed
    // or another tab is selected, the items become available again.
    menu.addEventListener("popupshowing", () => {
      const disabled = !KitSplit.canSplit();
      for (const entry of menu.querySelectorAll("menuitem")) {
        if (disabled) {
          entry.setAttribute("disabled", "true");
        } else {
          entry.removeAttribute("disabled");
        }
      }
    });
    (document.getElementById("mainPopupSet") || document.documentElement).append(menu);

    // Zen doesn't call the widget's onCommand, so catch the command on the window
    // (this way the button keeps working after Customize Toolbar recreates it)
    window.addEventListener(
      "command",
      event => {
        if (event.target?.id === "kit-split") {
          menu.openPopup(event.target, "after_end");
        }
      },
      true
    );

    // once: one button instead of the previous Split right / Split down pair,
    // in the same place (right after the fullscreen button)
    const DONE = "kit.layout.split-menu-placed";
    if (!Services.prefs.getBoolPref(DONE, false)) {
      for (const id of ["kit-split-right", "kit-split-down"]) {
        try {
          CustomizableUI.removeWidgetFromArea(id);
        } catch (e) {}
      }
      const position = CustomizableUI.getPlacementOfWidget("fullscreen-button")?.position;
      if (position !== undefined) {
        CustomizableUI.addWidgetToArea("kit-split", CustomizableUI.AREA_NAVBAR, position + 1);
      }
      Services.prefs.setBoolPref(DONE, true);
    }
  }

  // Zoom, fullscreen and the tab list go into the URL bar row, not a separate
  // row below it. Once only: after that the placement can be changed in Customize Toolbar.
  function mergeNavbarTools() {
    if (!window.CustomizableUI) {
      return;
    }
    // the all-tabs list isn't needed: tabs are already in the Tabs panel (once)
    const ALLTABS = "kit.layout.alltabs-removed";
    if (!Services.prefs.getBoolPref(ALLTABS, false)) {
      try {
        CustomizableUI.removeWidgetFromArea("alltabs-button");
      } catch (e) {}
      Services.prefs.setBoolPref(ALLTABS, true);
    }
    // back/forward/reload belong to the page, so put them right next to the URL:
    // remove the spring between them and the bar (once)
    const SPRING = "kit.layout.navbar-spring-removed";
    if (!Services.prefs.getBoolPref(SPRING, false)) {
      const ids = CustomizableUI.getWidgetIdsInArea(CustomizableUI.AREA_NAVBAR);
      const before = ids.slice(0, ids.indexOf("urlbar-container"));
      for (const id of before.filter(id => id.startsWith("customizableui-special-spring"))) {
        try {
          CustomizableUI.removeWidgetFromArea(id);
        } catch (e) {}
      }
      Services.prefs.setBoolPref(SPRING, true);
    }
    const DONE = "kit.layout.navbar-merged";
    if (Services.prefs.getBoolPref(DONE, false)) {
      return;
    }
    try {
      let position = CustomizableUI.getPlacementOfWidget("urlbar-container")?.position ?? -1;
      for (const id of ["zoom-controls", "fullscreen-button", "alltabs-button"]) {
        const place = CustomizableUI.getPlacementOfWidget(id);
        if (place?.area === "PersonalToolbar") {
          CustomizableUI.addWidgetToArea(id, CustomizableUI.AREA_NAVBAR, ++position);
        }
      }
      // the bookmarks bar has only hidden buttons and no bookmarks left: hide it
      const visible = CustomizableUI.getWidgetIdsInArea("PersonalToolbar").filter(
        id => !["sidebar-button", "fxms-bmb-button"].includes(id)
      );
      if (!visible.length) {
        CustomizableUI.setToolbarVisibility("PersonalToolbar", false);
      }
      Services.prefs.setBoolPref(DONE, true);
    } catch (e) {
      console.error("kit-layout: could not move toolbar buttons", e);
    }
  }

  // ---------------------------------------------------------------- startup

  function init() {
    // Site popups (Google sign-in, OAuth, payment) get no layout:
    // Zen hides the panels in them, and the moved window buttons would be invisible,
    // leaving no way to close the window. Keep them as regular Zen windows.
    if (document.documentElement.hasAttribute("popup-window") || !window.toolbar.visible) {
      return;
    }
    browserBox = document.getElementById("browser");
    const toolbox = document.getElementById("navigator-toolbox");
    const navbar = document.getElementById("zen-appcontent-navbar-wrapper");
    if (!browserBox || !toolbox || !navbar) {
      console.error("kit-layout: Zen window markup not found");
      return;
    }
    state = loadState();

    // Top bar: window buttons (macOS traffic lights; Zen keeps them in the tab
    // panel, so we move them to keep them from sliding away with it) and spaces.
    const titlebar = el("div");
    titlebar.id = "kit-titlebar";
    const windowButtons = toolbox.querySelector(".titlebar-buttonbox-container");
    if (windowButtons) {
      windowButtons.id = "kit-window-buttons";
      titlebar.append(windowButtons);
    }
    const workspaces = el("div");
    workspaces.id = "kit-workspaces";
    // navigation and URL bar also go in the top bar, at its full width:
    // the center is left to the site alone
    titlebar.append(workspaces, navbar);
    browserBox.append(titlebar);

    strips = {};
    zoneEls = {};
    for (const side of ["left", "right"]) {
      const strip = document.createXULElement("vbox");
      strip.id = `kit-strip-${side}`;
      strip.className = "kit-strip";
      const top = el("div", "kit-zone kit-zone-top");
      const bottom = el("div", "kit-zone kit-zone-bottom");
      top.dataset.zone = `${side}-top`;
      bottom.dataset.zone = `${side}-bottom`;
      strip.append(top, el("div", "kit-strip-spacer"), bottom);
      browserBox.append(strip);
      strips[side] = strip;
      zoneEls[`${side}-top`] = top;
      zoneEls[`${side}-bottom`] = bottom;
    }
    setupResizers();
    setupWorkspaces(workspaces);
    setupCenter(navbar);
    setupNavBalance();
    mergeNavbarTools();
    // Zen hardcodes the limit in MAX_TABS; there's no separate pref.
    // Raise it for all ways of splitting, including the menu and drag and drop.
    if (window.gZenViewSplitter) {
      window.gZenViewSplitter.MAX_TABS = Math.max(16, window.gZenViewSplitter.MAX_TABS);
    }
    window.KitSplit = KitSplit;
    setupSplitButtons();
    setupSplitClose();
    setupCreateFolder();
    setupDownloadAnimationTarget();
    document.documentElement.setAttribute("kit-layout", "true");

    window.KitLayout = KitLayout;
    for (const def of builtinTools()) {
      register(def);
    }
    const queued = window.kitLayoutQueue || [];
    window.kitLayoutQueue = { push: def => register(def) };
    queued.forEach(def => register(def));
    apply();
  }

  if (gBrowserInit.delayedStartupFinished) {
    init();
  } else {
    const observer = subject => {
      if (subject === window) {
        Services.obs.removeObserver(observer, "browser-delayed-startup-finished");
        init();
      }
    };
    Services.obs.addObserver(observer, "browser-delayed-startup-finished");
  }
})();
