// ==UserScript==
// @name           Live CSS
// @description    Applies theme, mods, site styles and *.uc.css changes right away, without a restart
// ==/UserScript==

// Фоновый модуль fx-autoconfig: загружается один раз при старте браузера.
//
// Firefox читает userChrome.css и userContent.css только при запуске, а новые
// @import на лету не подхватывает. Поэтому тему, моды и стили сайтов
// подключает этот модуль — через сервис стилей, который умеет снимать и
// ставить листы во время работы:
//   - импорты из kit/theme.css, kit/mods.css, kit/sites.css (и всё, что они
//     импортируют) и личные user/userChrome.css, user/userContent.css
//     склеиваются в один текст и ставятся как user-лист;
//   - в userChrome.css / userContent.css эти импорты стоят с условием
//     not -moz-pref("kit.css.live"): модуль включает настройку, и старые
//     импорты отключаются. Без загрузчика скриптов настройки нет — и CSS
//     работает как раньше, через импорты, но после перезапуска;
//   - раз в секунду модуль проверяет время изменения файлов и при любой
//     правке ставит свежую версию. Так же перечитываются CSS/*.uc.css.
// Новые *.uc.css и правки JS по-прежнему требуют перезапуска.

import { setInterval } from "resource://gre/modules/Timer.sys.mjs";

const PREF_LIVE = "kit.css.live";
const POLL_MS = 1000;
const sss = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);
const IMPORT_RE = /@import\s+(?:url\(\s*["']?([^"')]+)["']?\s*\)|["']([^"']+)["'])\s*([^;]*);/g;

const chromeDir = () => Services.dirsvc.get("UChrm", Ci.nsIFile).path;
const dataURI = text => Services.io.newURI("data:text/css;charset=utf-8," + encodeURIComponent(text));

// Текст файла со всеми @import, вставленными на место (с их медиа-условием).
// deps — все прочитанные файлы: за ними и следим.
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

// Тело userChrome.css / userContent.css без импортов (разовые правки внизу файла).
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
    this.sheets = { chrome: null, content: null }; // текущие data:-листы
    this.texts = { chrome: "", content: "" };
    this.mtimes = new Map(); // путь → время изменения
    this.authorSheets = new Map(); // имя .uc.css → текущий data:-адрес
    this.busy = false;
  }

  async start() {
    await this.rebuild();
    // включаем после того, как свои листы уже стоят, — без мигания
    Services.prefs.getDefaultBranch("").setBoolPref(PREF_LIVE, true);
    await this.snapshotAuthorStyles();
    Services.obs.addObserver(win => this.fixNewWindow(win), "browser-delayed-startup-finished");
    setInterval(() => this.poll(), POLL_MS);
  }

  // Собрать и поставить листы интерфейса и страниц заново.
  async rebuild() {
    const dir = chromeDir();
    const kit = name => PathUtils.join(dir, "kit", name);
    const deps = new Set();
    const user = name => PathUtils.join(dir, "user", name); // личный слой (bin/sync)
    const chrome =
      (await flatten(kit("theme.css"), deps)) +
      (await flatten(kit("mods.css"), deps)) +
      (await bodyOf(PathUtils.join(dir, "userChrome.css"), deps)) +
      (await flatten(user("userChrome.css"), deps));
    const content =
      (await flatten(kit("sites.css"), deps)) +
      (await bodyOf(PathUtils.join(dir, "userContent.css"), deps)) +
      (await flatten(user("userContent.css"), deps));
    // userChrome.css действует только на окна самого браузера, а лист из
    // сервиса стилей — на все документы, поэтому ограничиваем адресом
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
    // сначала новый, потом снять старый — чтобы не было кадра без стилей
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

  // ---- CSS/*.uc.css: их ставит загрузчик в каждое окно как author-лист

  styles() {
    try {
      const { Scripts } = ChromeUtils.importESModule("chrome://userchromejs/content/uc_api.sys.mjs");
      return Scripts.getStyleData().filter(s => s.isEnabled && s.styleSheetMode === "author");
    } catch (e) {
      return [];
    }
  }

  // у загрузчика адрес листа — строка
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

  // Новое окно загрузчик заполняет листами, прочитанными при старте, —
  // меняем их на свежие.
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

  // ---- слежение

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

  // Применить сразу, не дожидаясь проверки (после bin/theme, bin/mod, bin/site).
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
