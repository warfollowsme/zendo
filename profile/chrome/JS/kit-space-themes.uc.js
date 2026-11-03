// ==UserScript==
// @name           Space themes
// @description    Each space has its own theme: a Zendo theme or Zen's own colors from the space theme picker
// ==/UserScript==

// Every theme is loaded at once by kit-live-css.sys.mjs, each under
// :root[kit-theme="<name>"]; this script puts that attribute on the window for
// the active space. "Zen" (zen-default) removes it: then the space shows its
// own colors from Zen's theme picker (gradient, opacity, texture).
//
// Which theme a space has: kit.theme.spaces = { space uuid: theme name }.
// A space without an entry gets Zen's colors if they were set in the picker,
// otherwise the default theme (bin/theme / the Settings panel, kit.theme.default).
//
// The theme is chosen first: a Theme list is added to the Create Space form and
// on top of Zen's theme picker. With "Zen" the picker's controls show, with any
// other theme they are hidden. Without live CSS (no script loader) there is one
// theme for everything, from kit/theme.css.
(function () {
  if (!window.gBrowser || window.kitSpaceThemes || !window.gZenWorkspaces) {
    return;
  }
  const PREF = "kit.theme.spaces";
  const PREF_DEFAULT = "kit.theme.default";
  const PREF_LIVE = "kit.css.live";
  const ZEN = "zen-default";
  const root = document.documentElement;

  const assigned = () => {
    try {
      return JSON.parse(Services.prefs.getStringPref(PREF, "{}"));
    } catch (e) {
      return {};
    }
  };

  function themeOf(uuid) {
    const name = assigned()[uuid];
    if (name) {
      return name;
    }
    const space = gZenWorkspaces.getWorkspaces?.().find(w => w.uuid === uuid);
    if (space?.theme?.gradientColors?.length) {
      return ZEN;
    }
    return Services.prefs.getStringPref(PREF_DEFAULT, ZEN);
  }

  function setThemeOf(uuid, name) {
    const all = assigned();
    all[uuid] = name;
    Services.prefs.setStringPref(PREF, JSON.stringify(all));
  }

  function apply() {
    if (!Services.prefs.getBoolPref(PREF_LIVE, false)) {
      return;
    }
    const name = themeOf(gZenWorkspaces.activeWorkspace);
    if (name === ZEN) {
      root.removeAttribute("kit-theme");
    } else if (root.getAttribute("kit-theme") !== name) {
      root.setAttribute("kit-theme", name);
    }
  }

  // Themes from chrome/kit/themes (base and personal layer, linked by bin/sync).
  async function themes() {
    const list = [{ id: ZEN, name: "Zen" }];
    const dir = PathUtils.join(Services.dirsvc.get("UChrm", Ci.nsIFile).path, "kit", "themes");
    let files = [];
    try {
      files = await IOUtils.getChildren(dir);
    } catch (e) {}
    for (const path of files.sort()) {
      const file = PathUtils.filename(path);
      if (!file.endsWith(".css") || file.startsWith("._")) {
        continue;
      }
      let name = "";
      try {
        name = (await IOUtils.readUTF8(path)).match(/@name\s+(.+)/)?.[1]?.trim() || "";
      } catch (e) {}
      list.push({ id: file.slice(0, -4), name: name || file.slice(0, -4) });
    }
    return list;
  }

  // "Theme" row with a list; host gets kit-theme-chosen when it isn't "Zen",
  // and CSS (kit-space-themes.uc.css) hides Zen's color controls then.
  async function themeRow(host, uuid) {
    const row = document.createElement("div");
    row.className = "kit-space-theme";
    const label = document.createElement("span");
    label.textContent = "Theme";
    const select = document.createElement("select");
    select.className = "kit-select";
    const current = themeOf(uuid());
    for (const theme of await themes()) {
      const option = document.createElement("option");
      option.value = theme.id;
      option.textContent = theme.name;
      option.selected = theme.id === current;
      select.append(option);
    }
    const mark = () => host.toggleAttribute("kit-theme-chosen", select.value !== ZEN);
    select.addEventListener("change", () => {
      setThemeOf(uuid(), select.value);
      mark();
      apply();
    });
    row.append(label, select);
    mark();
    return { row, select, mark };
  }

  // ---- Create Space form

  async function setupCreation(form) {
    if (form.querySelector(".kit-space-theme")) {
      return;
    }
    await form.promiseInitialized;
    const edit = form.querySelector(".zen-workspace-creation-edit-theme-button");
    if (!edit) {
      return;
    }
    const { row } = await themeRow(form, () => form.getAttribute("workspace-id"));
    edit.before(row);
  }

  // ---- Zen's theme picker for a space

  let picker = null;
  async function setupPicker() {
    const panel = document.getElementById("PanelUI-zen-gradient-generator");
    const view = document.getElementById("PanelUI-zen-gradient-generator-view");
    if (!panel || !view) {
      return;
    }
    const uuid = () => window.gZenThemePicker?.workspaceBeingEdited?.uuid || gZenWorkspaces.activeWorkspace;
    panel.addEventListener("popupshowing", async event => {
      if (event.target !== panel) {
        return;
      }
      if (!picker) {
        picker = await themeRow(panel, uuid);
        view.prepend(picker.row);
      }
      picker.select.value = themeOf(uuid());
      picker.mark();
    });
  }

  function init() {
    window.kitSpaceThemes = { themeOf, apply };
    apply();
    setupPicker().catch(e => console.error("kit-space-themes:", e));

    // space switch: Zen marks the active <zen-workspace> with the active attribute;
    // the Create Space form is added inside the new space (both in the tab panel)
    const holder = document.getElementById("navigator-toolbox");
    if (holder) {
      new MutationObserver(records => {
        let switched = false;
        for (const record of records) {
          if (record.type === "attributes") {
            switched = true;
          }
          for (const node of record.addedNodes) {
            if (node.localName === "zen-workspace-creation") {
              setupCreation(node).catch(e => console.error("kit-space-themes:", e));
            }
          }
        }
        if (switched) {
          apply();
        }
      }).observe(holder, { subtree: true, childList: true, attributes: true, attributeFilter: ["active"] });
    }
    window.addEventListener("ZenWorkspacesUIUpdate", apply);
    window.addEventListener("ZenWorkspaceDataChanged", apply);

    const observer = () => apply();
    for (const pref of [PREF, PREF_DEFAULT, PREF_LIVE]) {
      Services.prefs.addObserver(pref, observer);
    }
    window.addEventListener("unload", () => {
      for (const pref of [PREF, PREF_DEFAULT, PREF_LIVE]) {
        Services.prefs.removeObserver(pref, observer);
      }
    });
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
