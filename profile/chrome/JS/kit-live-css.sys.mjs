// ==UserScript==
// @name           Live CSS
// @description    Applies theme, mods, site styles and *.uc.css changes right away, without a restart
// ==/UserScript==

// Background fx-autoconfig module: loaded once at browser startup.
//
// Firefox reads userChrome.css and userContent.css only at startup and doesn't
// pick up new @imports on the fly. So the theme, mods and site styles are
// loaded by this module, via the stylesheet service, which can remove and
// add sheets at runtime:
//   - imports from kit/theme.css, kit/mods.css, kit/sites.css (and everything they
//     import) plus the personal user/userChrome.css, user/userContent.css
//     are concatenated into one text and registered as a user sheet;
//   - in userChrome.css / userContent.css these imports carry the condition
//     not -moz-pref("kit.css.live"): the module turns the pref on, and the old
//     imports are disabled. Without the script loader the pref isn't set, and CSS
//     works as before, via imports, but only after a restart;
//   - once a second the module checks file modification times and on any
//     change registers the fresh version. CSS/*.uc.css are reloaded the same way.
// New *.uc.css files and JS changes still require a restart.

import { setInterval } from "resource://gre/modules/Timer.sys.mjs";

const PREF_LIVE = "kit.css.live";
const POLL_MS = 1000;
const sss = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);
const IMPORT_RE = /@import\s+(?:url\(\s*["']?([^"')]+)["']?\s*\)|["']([^"']+)["'])\s*([^;]*);/g;

const chromeDir = () => Services.dirsvc.get("UChrm", Ci.nsIFile).path;
const dataURI = text => Services.io.newURI("data:text/css;charset=utf-8," + encodeURIComponent(text));

// File text with every @import inlined in place (with its media condition).
// deps: all files read, which are the ones we watch.
async function flatten(path, deps, seen = new Set()) {
  deps.add(path);
  if (seen.has(path)) {
    return "";
  }
  seen.add(path);
  let text;
  try {
    text = await IOUtils.readUTF8(path);
  } catch (e) {
    return `/* kit-live-css: cannot read ${path} */\n`;
  }
  let out = "";
  let last = 0;
  for (const m of text.matchAll(IMPORT_RE)) {
    out += text.slice(last, m.index);
    last = m.index + m[0].length;
    const target = PathUtils.normalize(PathUtils.joinRelative(PathUtils.parent(path), m[1] || m[2]));
    const inner = await flatten(target, deps, seen);
    const media = m[3].trim();
    out += media ? `@media ${media} {\n${inner}\n}\n` : inner;
  }
  return (out + text.slice(last)).replace(/@charset\s+[^;]+;/g, "");
}

// Body of userChrome.css / userContent.css without imports (one-off tweaks at the end of the file).
async function bodyOf(path, deps) {
  deps.add(path);
  try {
    return (await IOUtils.readUTF8(path)).replace(IMPORT_RE, "");
  } catch (e) {
    return "";
  }
}

class LiveCSS {
  constructor() {
    this.sheets = { chrome: null, content: null }; // current data: sheets
    this.texts = { chrome: "", content: "" };
    this.mtimes = new Map(); // path → modification time
    this.authorSheets = new Map(); // .uc.css name → current data: URL
    this.busy = false;
  }

  async start() {
    await this.rebuild();
    // turn it on after our own sheets are in place, to avoid flicker
    Services.prefs.getDefaultBranch("").setBoolPref(PREF_LIVE, true);
    await this.snapshotAuthorStyles();
    Services.obs.addObserver(win => this.fixNewWindow(win), "browser-delayed-startup-finished");
    setInterval(() => this.poll(), POLL_MS);
  }

  // Rebuild and register the chrome and content sheets.
  async rebuild() {
    const dir = chromeDir();
    const kit = name => PathUtils.join(dir, "kit", name);
    const deps = new Set();
    const user = name => PathUtils.join(dir, "user", name); // personal layer (bin/sync)
    const chrome =
      (await flatten(kit("theme.css"), deps)) +
      (await flatten(kit("mods.css"), deps)) +
      (await bodyOf(PathUtils.join(dir, "userChrome.css"), deps)) +
      (await flatten(user("userChrome.css"), deps));
    const content =
      (await flatten(kit("sites.css"), deps)) +
      (await bodyOf(PathUtils.join(dir, "userContent.css"), deps)) +
      (await flatten(user("userContent.css"), deps));
    // userChrome.css applies only to the browser's own windows, while a sheet from
    // the stylesheet service applies to all documents, so we restrict it by URL
    this.apply("chrome", `@-moz-document url-prefix("chrome:") {\n${chrome}\n}`);
    this.apply("content", content);
    for (const path of deps) {
      if (!this.mtimes.has(path)) {
        this.mtimes.set(path, await this.mtime(path));
      }
    }
    for (const path of [...this.mtimes.keys()]) {
      if (!deps.has(path) && !path.endsWith(".uc.css")) {
        this.mtimes.delete(path);
      }
    }
  }

  apply(kind, text) {
    if (text === this.texts[kind]) {
      return;
    }
    const uri = dataURI(text);
    // add the new one first, then remove the old, so there's no frame without styles
    sss.loadAndRegisterSheet(uri, sss.USER_SHEET);
    if (this.sheets[kind]) {
      sss.unregisterSheet(this.sheets[kind], sss.USER_SHEET);
    }
    this.sheets[kind] = uri;
    this.texts[kind] = text;
  }

  async mtime(path) {
    try {
      return (await IOUtils.stat(path)).lastModified;
    } catch (e) {
      return 0;
    }
  }

  // ---- CSS/*.uc.css: the loader adds them to every window as author sheets

  styles() {
    try {
      const { Scripts } = ChromeUtils.importESModule("chrome://userchromejs/content/uc_api.sys.mjs");
      return Scripts.getStyleData().filter(s => s.isEnabled && s.styleSheetMode === "author");
    } catch (e) {
      return [];
    }
  }

  // the loader stores the sheet URL as a string
  styleURI(style) {
    return typeof style.referenceURI === "string" ? Services.io.newURI(style.referenceURI) : style.referenceURI;
  }

  stylePath(style) {
    return PathUtils.join(chromeDir(), "CSS", style.filename);
  }

  async snapshotAuthorStyles() {
    for (const style of this.styles()) {
      this.mtimes.set(this.stylePath(style), await this.mtime(this.stylePath(style)));
    }
  }

  async reloadAuthorStyle(style) {
    const text = await IOUtils.readUTF8(this.stylePath(style));
    const uri = dataURI(text);
    const old = this.authorSheets.get(style.filename) || this.styleURI(style);
    for (const win of Services.wm.getEnumerator(null)) {
      if (style.regex.test(win.location.href)) {
        try {
          win.windowUtils.removeSheet(old, win.windowUtils.AUTHOR_SHEET);
          win.windowUtils.loadSheet(uri, win.windowUtils.AUTHOR_SHEET);
        } catch (e) {
          console.error("kit-live-css:", style.filename, e);
        }
      }
    }
    this.authorSheets.set(style.filename, uri);
  }

  // The loader fills a new window with sheets read at startup;
  // swap them for fresh ones.
  fixNewWindow(win) {
    for (const style of this.styles()) {
      const uri = this.authorSheets.get(style.filename);
      if (uri && style.regex.test(win.location.href)) {
        try {
          win.windowUtils.removeSheet(this.styleURI(style), win.windowUtils.AUTHOR_SHEET);
          win.windowUtils.loadSheet(uri, win.windowUtils.AUTHOR_SHEET);
        } catch (e) {
          console.error("kit-live-css:", style.filename, e);
        }
      }
    }
  }

  // ---- watching

  async poll() {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      let kitChanged = false;
      const styles = new Map(this.styles().map(s => [this.stylePath(s), s]));
      for (const [path, old] of this.mtimes) {
        const now = await this.mtime(path);
        if (now === old) {
          continue;
        }
        this.mtimes.set(path, now);
        const style = styles.get(path);
        if (style) {
          await this.reloadAuthorStyle(style);
        } else {
          kitChanged = true;
        }
      }
      if (kitChanged) {
        await this.rebuild();
      }
    } catch (e) {
      console.error("kit-live-css:", e);
    } finally {
      this.busy = false;
    }
  }

  // Apply right away without waiting for the check (after bin/theme, bin/mod, bin/site).
  async reload() {
    await this.poll();
    await this.rebuild();
  }
}

const live = new LiveCSS();
live.start().catch(e => console.error("kit-live-css:", e));

export const KitLiveCSS = {
  reload: () => live.reload(),
  get active() {
    return Services.prefs.getBoolPref(PREF_LIVE, false);
  },
};
