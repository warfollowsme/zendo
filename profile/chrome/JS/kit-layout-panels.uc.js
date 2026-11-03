// ==UserScript==
// @name           Layout: Settings, Develop, Boosts and Media tools
// @description    Built-in layout panels, Boosts management and Media display modes
// ==/UserScript==

// Panels are created by the layout (kit-layout.uc.js) on first open via
// window.KitLayoutPanels.settings(body) / .develop(body).
// Themes, mods and site styles are switched with the same bin/theme,
// bin/mod, bin/site commands as from the terminal; project files remain the source of truth.
// Look matches Zen Library sections: groups with a small heading, pill-shaped rows.
(function () {
  const HTML = "http://www.w3.org/1999/xhtml";
  const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

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

  function button(label, onClick, title) {
    const b = el("button", "kit-button", label);
    if (title) {
      b.title = title;
    }
    b.addEventListener("click", onClick);
    return b;
  }

  function group(title) {
    const box = el("div", "kit-group");
    box.append(el("h3", null, title));
    return box;
  }

  function chips(...buttons) {
    const box = el("div", "kit-chips");
    box.append(...buttons);
    return box;
  }

  // Toggle row, like in Zen settings: checkbox, then the name;
  // the description goes in the hover tooltip.
  function toggleRow(id, title, hint, checked, onChange) {
    const row = el("label", "kit-row");
    row.htmlFor = id;
    if (hint) {
      row.title = hint;
    }
    const box = el("input", "kit-check");
    box.type = "checkbox";
    box.id = id;
    box.checked = checked;
    box.addEventListener("change", () => onChange(box.checked));
    row.append(box, el("span", "kit-row-title", title));
    return row;
  }

  // ---------------------------------------------------------------- repository and bin/*

  function findRepo() {
    const pref = Services.prefs.getStringPref("kit.ai.repo", "");
    if (pref) {
      return pref;
    }
    const file = Services.dirsvc.get("UChrm", Ci.nsIFile);
    file.append("userChrome.css");
    if (!file.isSymlink()) {
      return null;
    }
    let path = file.target; // <repo>/profile/chrome/userChrome.css
    for (let i = 0; i < 3; i++) {
      path = PathUtils.parent(path);
    }
    return path;
  }

  async function bin(repo, name, ...args) {
    const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
    const proc = await Subprocess.call({
      command: "/bin/bash",
      arguments: [PathUtils.join(repo, "bin", name), ...args],
      workdir: repo,
      environment: { PATH: `${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, NO_COLOR: "1" },
      environmentAppend: true,
      stderr: "stdout",
    });
    let out = "";
    const decoder = new TextDecoder();
    for (;;) {
      const buf = await proc.stdout.read().catch(() => null);
      if (!buf || !buf.byteLength) {
        break;
      }
      out += decoder.decode(buf, { stream: true });
    }
    const { exitCode } = await proc.wait();
    return { exitCode, out: out.replace(/\x1b\[[0-9;]*m/g, "") };
  }

  // Themes, mods and sites are read from the profile's kit/: bin/sync has merged
  // the base and personal layer files there (~/.config/zendo).
  const kitPath = (...parts) => PathUtils.join(Services.dirsvc.get("UChrm", Ci.nsIFile).path, "kit", ...parts);

  async function readMeta(path) {
    const head = (await IOUtils.readUTF8(path)).slice(0, 1500);
    const meta = key => head.match(new RegExp(`@${key}\\s+(.+)`))?.[1]?.trim() || "";
    return { id: PathUtils.filename(path).replace(/\.css$/, ""), name: meta("name"), description: meta("description") };
  }

  async function listKit(kind) {
    const files = (await IOUtils.getChildren(kitPath(kind))).filter(
      p => p.endsWith(".css") && !PathUtils.filename(p).startsWith(".")
    );
    return Promise.all(files.sort().map(readMeta));
  }

  async function enabled(kind) {
    try {
      const text = await IOUtils.readUTF8(kitPath(`${kind}.css`));
      return new Set([...text.matchAll(new RegExp(`@import url\\("${kind}/(.+?)\\.css"\\)`, "g"))].map(m => m[1]));
    } catch (e) {
      return new Set();
    }
  }

  // Run bin/sync before restarting: new personal scripts and user.js get into the profile.
  async function restart() {
    const repo = findRepo();
    if (repo) {
      await bin(repo, "sync", "--quiet").catch(e => console.error("kit-layout-panels:", e));
    }
    Services.appinfo.invalidateCachesOnRestart();
    Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart);
  }

  // ---------------------------------------------------------------- Settings

  async function settings(body) {
    body.classList.add("kit-list-body");
    const repo = findRepo();
    if (!repo) {
      body.append(el("div", "kit-empty", "The profile is not linked to the repository (bin/install) — themes and mods are unavailable."));
      return;
    }
    // Theme, mods and site styles are applied live by kit-live-css.sys.mjs; without it
    // (no script loader) they're included via @import and wait for a restart.
    const status = el("div", "kit-status");
    const live = () => {
      try {
        return ChromeUtils.importESModule("chrome://userscripts/content/kit-live-css.sys.mjs").KitLiveCSS;
      } catch (e) {
        return null;
      }
    };
    const changed = async (exitCode, out) => {
      if (exitCode) {
        status.replaceChildren(out.trim());
        return;
      }
      const css = live();
      if (css?.active) {
        await css.reload();
        status.replaceChildren("Applied.");
      } else {
        status.replaceChildren("Done — applies after a restart. ", button("Restart now", restart));
      }
    };

    const render = async () => {
      await bin(repo, "sync", "--quiet"); // new personal layer files go into the list
      body.replaceChildren();

      const themeBox = group("Default theme"); // for spaces without their own (kit-space-themes.uc.js)
      const info = el("span", "kit-info");
      info.title =
        "The theme for spaces that don't have their own.\n\n" +
        "If nothing changes when you pick a theme here, the current space has its own theme.";
      themeBox.firstChild.append(info);
      let current = "";
      try {
        current = (await IOUtils.readUTF8(kitPath("theme.css"))).match(/theme:\s*(\S+)/)?.[1] || "";
      } catch (e) {}
      const select = el("select", "kit-select");
      for (const theme of [{ id: "zen-default", name: "Zen" }, ...(await listKit("themes"))]) {
        const option = el("option", null, theme.name || theme.id);
        option.value = theme.id;
        option.selected = theme.id === current;
        select.append(option);
      }
      select.addEventListener("change", async () => {
        select.disabled = true;
        const { exitCode, out } = await bin(repo, "theme", select.value);
        select.disabled = false;
        changed(exitCode, out);
      });
      themeBox.append(select);

      const toggles = async (kind, title, cmd) => {
        const box = group(title);
        const on = await enabled(kind);
        const items = await listKit(kind);
        if (!items.length) {
          box.append(el("div", "kit-empty", "Nothing here yet."));
        }
        for (const item of items) {
          box.append(
            toggleRow(`kit-${kind}-${item.id}`, item.name || item.id, item.description, on.has(item.id), async checked => {
              const { exitCode, out } = await bin(repo, cmd, checked ? "on" : "off", item.id);
              changed(exitCode, out);
            })
          );
        }
        return box;
      };

      const layoutBox = group("Layout");
      layoutBox.append(
        chips(
          button(
            "Reset layout",
            () => window.KitLayout?.reset(),
            "Drag tool icons between the four toolbar zones: a panel opens in the zone of its icon. Reset puts them back."
          )
        )
      );

      const browserBox = group("Browser");
      browserBox.append(
        chips(button("All Zen settings", () => openTrustedLinkIn("about:preferences", "tab")), button("Restart", restart))
      );

      body.append(
        themeBox,
        await toggles("mods", "Interface mods", "mod"),
        await toggles("sites", "Site styles", "site"),
        layoutBox,
        browserBox,
        status
      );
    };
    await render();
  }

  // ---------------------------------------------------------------- Develop

  const OUR_SOURCES = /chrome:\/\/(userscripts|userchrome|userchromejs|userstyles)\/|kit-ai|kit-layout/;

  function develop(body) {
    body.classList.add("kit-list-body");
    const repo = findRepo();
    const press = id => {
      const key = document.getElementById(id);
      const command = key?.getAttribute("command");
      (command ? document.getElementById(command) : key)?.doCommand();
    };

    const tools = group("Tools");
    tools.append(
      chips(
        button("Browser Console", () => press("key_browserConsole"), "Errors and logs of the whole browser (Cmd+Shift+J)"),
        button("Browser Toolbox", () => press("key_browserToolbox"), "Inspect the browser UI (Cmd+Opt+Shift+I)"),
        button("Page DevTools", () => press("key_toggleToolbox"), "Developer tools for the open site"),
        button("Restart + clear cache", restart, "Needed after editing JS")
      )
    );

    const check = group("Project check");
    const checkOut = el("pre", "kit-pre");
    checkOut.hidden = true;
    check.append(
      chips(
        button("Run bin/check", async () => {
          checkOut.hidden = false;
          checkOut.textContent = "Checking…";
          const { out } = repo ? await bin(repo, "check") : { out: "Repository not found" };
          checkOut.textContent = out.trim();
        })
      ),
      checkOut
    );

    const scripts = group("Scripts (fx-autoconfig)");
    const note = el("div", "kit-row-hint kit-pad");
    try {
      const { Scripts } = ChromeUtils.importESModule("chrome://userchromejs/content/uc_api.sys.mjs");
      for (const script of Scripts.getScriptData()) {
        scripts.append(
          toggleRow(`kit-script-${script.filename}`, script.name || script.filename, script.filename, script.isEnabled, () => {
            Scripts.toggleScript(script.filename);
            note.textContent = "Applies after a restart.";
          })
        );
      }
    } catch (e) {
      scripts.append(el("div", "kit-empty", "The script loader is not available."));
    }
    scripts.append(note);

    // Errors from our scripts and styles, from the shared browser console.
    const errors = group("Project script errors");
    const list = el("div");
    errors.append(chips(button("Clear", () => list.replaceChildren())), list);
    const add = message => {
      let entry;
      try {
        const error = message.QueryInterface(Ci.nsIScriptError);
        if (!OUR_SOURCES.test(error.sourceName + " " + error.errorMessage)) {
          return;
        }
        entry = el("div", "kit-log-entry", `${error.errorMessage}\n${error.sourceName}:${error.lineNumber}`);
        entry.setAttribute("level", error.flags & Ci.nsIScriptError.warningFlag ? "warning" : "error");
      } catch (e) {
        const text = message.message || "";
        if (!OUR_SOURCES.test(text)) {
          return;
        }
        entry = el("div", "kit-log-entry", text);
      }
      list.prepend(entry);
      while (list.childElementCount > 100) {
        list.lastChild.remove();
      }
    };
    for (const message of Services.console.getMessageArray() || []) {
      add(message);
    }
    const listener = { observe: add };
    Services.console.registerListener(listener);
    window.addEventListener("unload", () => Services.console.unregisterListener(listener), { once: true });

    body.append(tools, check, scripts, errors);
  }

  // We extend Zen's built-in list: search and its state stay with the section,
  // New boost sits next to search, row actions are as in Extensions.
  function boosts(body) {
    const section = body?.querySelector("zen-library-boosts-section");
    if (!window.gBrowser || !section || document.getElementById("kit-boosts-new")) {
      return;
    }
    const { gZenBoostsManager: manager } = ChromeUtils.importESModule(
      "resource:///modules/zen/boosts/ZenBoostsManager.sys.mjs"
    );
    const status = el("div");
    status.id = "kit-boosts-status";
    status.setAttribute("role", "status");
    body.append(status);
    let creating = false;
    const busy = new Set();
    const key = boost => `${boost.domain}/${boost.id}`;

    function report(error) {
      console.error("[kit-boosts]", error);
      status.textContent = "Boost action failed. Please try again.";
    }

    function currentURI() {
      const uri = gBrowser.currentURI;
      return Services.prefs.getBoolPref("zen.boosts.enabled", false) && manager.canBoostSite(uri) ? uri : null;
    }

    function update() {
      try {
        const uri = currentURI();
        create.disabled = creating || !uri;
        create.title = uri ? `Create a new boost for ${uri.host}` :
          "Boosts are available on HTTP and HTTPS websites";
      } catch (error) {
        create.disabled = true;
        report(error);
      }
    }

    const create = button("", () => {
      if (creating) return;
      try {
        const uri = currentURI();
        if (!uri) return;
        creating = true;
        status.textContent = "";
        update();
        const boost = manager.createNewBoost(uri.host);
        if (!boost || !manager.openBoostWindow(window, boost, uri)) {
          throw new Error("The Boost editor could not be opened.");
        }
      } catch (error) {
        report(error);
      } finally {
        creating = false;
        update();
      }
    });
    create.id = "kit-boosts-new";
    create.className = "zen-library-filter-button";
    const plus = el("img");
    plus.src = "chrome://browser/skin/zen-icons/plus.svg";
    plus.alt = "";
    create.append(plus, el("span", null, "New boost"));

    // Order/filter match ZenLibraryBoostsSection.#boosts: this is how
    // we bind actions to the built-in rows without creating a second list.
    function visibleBoosts() {
      const query = section.searchQuery.toLowerCase();
      const result = [];
      for (const [domain, entry] of manager.registeredDomains) {
        for (const [id, boost] of entry.boostEntries) {
          const data = boost.boostData;
          if (data.changeWasMade && (!query || data.boostName.toLowerCase().includes(query) || domain.toLowerCase().includes(query))) {
            result.push({ id, domain, name: data.boostName, enabled: entry.activeBoostId === id });
          }
        }
      }
      return result.sort((a, b) => a.name.localeCompare(b.name) || a.domain.localeCompare(b.domain));
    }

    async function run(boost, command) {
      const id = key(boost);
      if (busy.has(id)) return;
      busy.add(id);
      status.textContent = "";
      decorate();
      try {
        await command();
      } catch (error) {
        report(error);
      } finally {
        busy.delete(id);
        section.requestUpdate();
      }
    }

    function control(boost, action, title, icon, command) {
      const node = el("button", "kit-icon-button kit-mask-icon kit-boosts-control");
      node.id = `kit-boosts-${action}-${encodeURIComponent(key(boost))}`;
      node.type = "button";
      node.dataset.action = action;
      node.title = title;
      node.setAttribute("aria-label", title);
      node.style.setProperty("--kit-icon", `url("chrome://browser/skin/zen-icons/${icon}.svg")`);
      node.disabled = busy.has(key(boost));
      node.addEventListener("click", event => {
        event.stopPropagation();
        void run(boost, command);
      });
      return node;
    }

    function decorate() {
      const header = section.querySelector(".zen-library-search-header");
      if (header && create.parentElement !== header) header.append(create);
      const boosts = visibleBoosts();
      const rows = section.querySelectorAll(".zen-library-boost-row");
      rows.forEach((row, index) => {
        const boost = boosts[index];
        if (!boost) return;
        row.classList.add("kit-boosts-row");
        row.title = `${boost.name} — ${boost.domain}`;
        row.querySelectorAll(".kit-boosts-control").forEach(node => node.remove());
        const edit = control(boost, "edit", "Edit boost", "edit-theme", async () => {
          // The built-in click opens the site in Glance and launches the editor.
          // For a disabled boost, first refresh the built-in click binding.
          if (manager.getActiveBoostId(boost.domain) !== boost.id) {
            manager.makeBoostActiveForDomain(boost.domain, boost.id);
            await section.updateComplete;
          }
          if (row.isConnected) row.click();
        });
        const toggle = control(boost, "toggle", boost.enabled ? "Disable boost" : "Enable boost",
          boost.enabled ? "block" : "boost", () => manager.toggleBoostActiveForDomain(boost.domain, boost.id));
        toggle.setAttribute("aria-pressed", String(boost.enabled));
        const remove = control(boost, "remove", "Remove boost", "trash", () => {
          if (Services.prompt.confirm(window, "Remove boost", `Remove “${boost.name}” for ${boost.domain}?`)) {
            manager.deleteBoost(boost);
          }
        });
        row.append(edit, toggle, remove);
      });
      update();
    }

    // Lit calls updated after every built-in render, including search
    // and boost toggling. We don't replace render or Zen's list handlers.
    const nativeUpdated = section.updated;
    section.updated = function (changed) {
      nativeUpdated.call(this, changed);
      try { decorate(); } catch (error) { report(error); }
    };
    section.requestUpdate();
    update();

    const observer = { observe: update };
    const progress = {
      QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
      onLocationChange(webProgress) {
        if (webProgress.isTopLevel) update();
      },
    };
    gBrowser.tabContainer.addEventListener("TabSelect", update);
    gBrowser.addProgressListener(progress);
    Services.prefs.addObserver("zen.boosts.enabled", observer);
    window.addEventListener("unload", () => {
      gBrowser.tabContainer.removeEventListener("TabSelect", update);
      gBrowser.removeProgressListener(progress);
      Services.prefs.removeObserver("zen.boosts.enabled", observer);
    }, { once: true });
  }

  // ---------------------------------------------------------------- Media

  // Media section view: cards (as in Zen), list or table. The section itself
  // is built-in and Zen doesn't know about our view: the view is set by an attribute on our
  // container plus CSS, and the captions are our own elements inside Zen's cards.
  // Zen rebuilds the cards on search and folder changes, so captions
  // are re-added via MutationObserver. Cards have no size or date
  // (only the section's internal data does), so the table shows name and type.
  const MEDIA_VIEWS = [
    ["cards", "Cards"],
    ["list", "List"],
    ["table", "Table"],
  ];
  const MEDIA_PREF = "kit.media.view";

  function media(body, actions) {
    const section = body?.querySelector("zen-library-media-section");
    if (!section || !actions || body.querySelector(".kit-media-views")) {
      return;
    }
    const switcher = el("div", "kit-media-views");
    const buttons = MEDIA_VIEWS.map(([mode, title]) => {
      const b = el("button", "kit-icon-button kit-mask-icon");
      b.title = title;
      b.dataset.mode = mode;
      b.style.setProperty("--kit-icon", `url("chrome://userchrome/content/kit-layout/icons/view-${mode}.svg")`);
      b.addEventListener("click", () => Services.prefs.setStringPref(MEDIA_PREF, mode));
      switcher.append(b);
      return b;
    });
    actions.prepend(switcher);

    const decorate = () => {
      const table = body.dataset.kitMediaView === "table";
      for (const grid of body.querySelectorAll(".zen-library-media-grid")) {
        const head = grid.querySelector(":scope > .kit-media-head");
        if (table && !head && grid.childElementCount) {
          const row = el("div", "kit-media-head");
          row.append(el("span"), el("span", null, "Name"), el("span", null, "Type"));
          grid.prepend(row);
        } else if (!table && head) {
          head.remove();
        }
      }
      for (const card of body.querySelectorAll(".zen-library-media-item:not([kit-media])")) {
        const name = card.title || "";
        const dot = name.lastIndexOf(".");
        card.setAttribute("kit-media", "");
        card.append(
          el("span", "kit-media-name", name),
          el("span", "kit-media-type", dot > 0 ? name.slice(dot + 1).toUpperCase() : "—")
        );
      }
    };
    const apply = () => {
      const saved = Services.prefs.getStringPref(MEDIA_PREF, "cards");
      const mode = MEDIA_VIEWS.some(([m]) => m === saved) ? saved : "cards";
      body.dataset.kitMediaView = mode;
      for (const b of buttons) {
        b.classList.toggle("kit-active", b.dataset.mode === mode);
      }
      decorate();
    };
    const observer = new MutationObserver(decorate);
    observer.observe(section, { childList: true, subtree: true });
    const prefObserver = { observe: apply };
    Services.prefs.addObserver(MEDIA_PREF, prefObserver);
    window.addEventListener(
      "unload",
      () => {
        observer.disconnect();
        Services.prefs.removeObserver(MEDIA_PREF, prefObserver);
      },
      { once: true }
    );
    apply();
  }

  window.KitLayoutPanels = { settings, develop, boosts, media };
})();
