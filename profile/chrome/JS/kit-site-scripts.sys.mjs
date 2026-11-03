// ==UserScript==
// @name           Site scripts
// @description    Runs sites/<name>.js on matching pages while the site style <name> is enabled
// ==/UserScript==

// Фоновый модуль fx-autoconfig: загружается один раз при старте браузера.
//
// Стиль сайта иногда нуждается в кнопке или переключателе — CSS этого не
// умеет. Тогда рядом со стилем кладётся sites/<имя>.js: он включается и
// выключается вместе со стилем (bin/site on|off <имя>) и запускается на
// страницах доменов из заголовка:
//   // ==UserScript==
//   // @name    …
//   // @domain  example.com        (и поддомены; строк @domain может быть несколько)
//   // ==/UserScript==
// Скрипт выполняется после загрузки разметки страницы (DOMContentLoaded),
// только в главном окне вкладки, с правами страницы — через песочницу с
// Xray, как run_page_js у ИИ-помощника: страница не видит его переменных.
//
// Список включённых скриптов модуль раз в секунду сверяет с файлами и
// передаёт в процессы страниц через sharedData. Правка скрипта действует
// на страницах, открытых после неё (или после обновления вкладки).

import { setInterval } from "resource://gre/modules/Timer.sys.mjs";

const KEY = "kit:site-scripts";
const POLL_MS = 1000;
const IMPORT_RE = /@import\s+url\("sites\/(.+)\.css"\);/g;

const kitDir = () => PathUtils.join(Services.dirsvc.get("UChrm", Ci.nsIFile).path, "kit");

// Скрипт для процесса каждой вкладки: ждёт загрузки страницы и запускает
// подходящие скрипты сайтов.
function frameScript(key) {
  const fits = (host, domain) => host === domain || host.endsWith("." + domain);
  addEventListener(
    "DOMContentLoaded",
    event => {
      const win = event.target.defaultView;
      if (!win || win !== win.top || !/^https?:$/.test(win.location.protocol)) {
        return;
      }
      for (const script of Services.cpmm.sharedData.get(key) || []) {
        if (!script.domains.some(d => fits(win.location.hostname, d))) {
          continue;
        }
        try {
          const sandbox = Cu.Sandbox(win, {
            sandboxPrototype: win,
            wantXrays: true,
            sandboxName: `kit site script ${script.name}`,
          });
          Cu.evalInSandbox(script.source, sandbox, "latest", `kit-sites/${script.name}.js`, 1);
        } catch (e) {
          console.error(`kit-site-scripts: ${script.name}:`, e);
        }
      }
    },
    true
  );
}

class SiteScripts {
  constructor() {
    this.stamp = ""; // что прочитано в прошлый раз: имена и время изменения
    this.busy = false;
  }

  start() {
    this.poll().then(() => {
      const source = `(${frameScript})(${JSON.stringify(KEY)});`;
      Services.mm.loadFrameScript("data:application/javascript;charset=utf-8," + encodeURIComponent(source), true);
    });
    setInterval(() => this.poll(), POLL_MS);
  }

  async stat(path) {
    try {
      return (await IOUtils.stat(path)).lastModified;
    } catch (e) {
      return 0;
    }
  }

  // Включённые стили сайтов — из kit/sites.css, который пишет bin/site.
  async enabled() {
    try {
      const text = await IOUtils.readUTF8(PathUtils.join(kitDir(), "sites.css"));
      return [...text.matchAll(IMPORT_RE)].map(m => m[1]);
    } catch (e) {
      return [];
    }
  }

  async poll() {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      const names = await this.enabled();
      const paths = names.map(name => PathUtils.join(kitDir(), "sites", `${name}.js`));
      const times = await Promise.all(paths.map(p => this.stat(p)));
      const stamp = JSON.stringify([names, times]);
      if (stamp === this.stamp) {
        return;
      }
      this.stamp = stamp;
      const scripts = [];
      for (const [i, path] of paths.entries()) {
        let source;
        try {
          source = await IOUtils.readUTF8(path);
        } catch (e) {
          continue; // у стиля нет скрипта — обычное дело
        }
        const header = source.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/)?.[1] || "";
        const domains = [...header.matchAll(/@domain\s+(\S+)/g)].map(m => m[1].toLowerCase());
        if (!domains.length) {
          console.error(`kit-site-scripts: sites/${names[i]}.js has no @domain in its header`);
          continue;
        }
        scripts.push({ name: names[i], domains, source });
      }
      Services.ppmm.sharedData.set(KEY, scripts);
      Services.ppmm.sharedData.flush();
    } catch (e) {
      console.error("kit-site-scripts:", e);
    } finally {
      this.busy = false;
    }
  }
}

new SiteScripts().start();
