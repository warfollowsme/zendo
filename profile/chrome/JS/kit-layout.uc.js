// ==UserScript==
// @name           Layout: toolbars and side panels
// @description    Toolbars on the window edges with four tool zones and island side panels
// ==/UserScript==

// Окно превращается в сетку (стили — CSS/kit-layout.uc.css):
//
//   ┌─ светофор · пространства 1 2 3 · навигация и адресная строка ─┐
//   │ тулбар │ левая панель │     сайт     │ правая панель │ тулбар │
//
// У каждого тулбара две зоны: верхняя (значки сверху вниз) и нижняя (снизу
// вверх). В каждой зоне открыт максимум один инструмент. Инструмент из
// верхней зоны занимает верх своей стороны, из нижней — низ; если на стороне
// открыт один инструмент, он во всю высоту. Значки перетаскиваются между зонами.
//
// Вкладки — это панель самого Zen (#navigator-toolbox): её не переносим по
// разметке, а только ставим в нужную ячейку сетки.
//
// Другие скрипты добавляют свои инструменты так (порядок загрузки не важен):
//   (window.kitLayoutQueue ??= []).push({ id, title, icon, zone, create(body) {…} });
// icon — имя иконки Zen ("settings" → chrome://browser/skin/zen-icons/settings.svg)
// или "library:<раздел>" — анимированная иконка раздела «Библиотеки» Zen.
// и управляют ими через window.KitLayout.show(id) / hide(id) / toggle(id).
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
  // Инструменты, которых больше нет: убираем из сохранённого расположения.
  const REMOVED_TOOLS = ["spaces"];

  const tools = new Map(); // id → описание инструмента
  const buttons = new Map(); // id → значок в тулбаре
  const panels = new Map(); // id → элемент панели в сетке
  const shown = new Set(); // инструменты, панели которых сейчас видны
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

  // Значок инструмента: иконка Zen через маску (цвет — от текста) или
  // анимированный спрайт раздела «Библиотеки» — как на её боковой панели.
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

  // ---------------------------------------------------------------- состояние

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
    // инструмент, которого нет ни в одной зоне (новый), — в его зону по умолчанию
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

  // ---------------------------------------------------------------- инструменты

  function register(def) {
    if (!def?.id || tools.has(def.id)) {
      return;
    }
    tools.set(def.id, def);
    if (def.element) {
      // Готовый элемент (панель вкладок Zen) включаем в раскладку сразу, а не
      // при первом показе: иначе, пока он закрыт, сетка ставит его в первую
      // свободную ячейку поверх сайта или других панелей.
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
      panel = def.element; // уже подготовлен в register()
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

  // ---------------------------------------------------------------- раскладка

  function apply() {
    // значки по зонам
    for (const zone of ZONES) {
      const list = state.zones[zone].filter(id => tools.has(id));
      zoneEls[zone].replaceChildren(...list.map(id => buttons.get(id)));
    }
    for (const [id, button] of buttons) {
      const active = state.active[zoneOf(id)] === id;
      if (active && !button.hasAttribute("active")) {
        // спрайт «Библиотеки» проигрывает анимацию при открытии, как в самом Zen
        button.setAttribute("animate", "true");
        setTimeout(() => button.removeAttribute("animate"), 700);
      }
      button.toggleAttribute("active", active);
    }

    // какие панели где
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

    // сетка
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

    // уведомить инструменты
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

  // ---------------------------------------------------------------- перетаскивание значков

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
      // нижняя зона растёт снизу вверх
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
    // index считали среди зарегистрированных значков — переводим в индекс полного списка
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

  // ---------------------------------------------------------------- изменение размеров

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

  // ---------------------------------------------------------------- встроенные инструменты

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

  // Разделы «Библиотеки» Zen (история, загрузки, медиа, бусты) —
  // это отдельные элементы <zen-library-*-section>. Ставим их прямо в панель.
  // От самой «Библиотеки» им нужно немного: requestUpdate, keepOpenWhile и
  // constructor.toggle (закрыть библиотеку после открытия ссылки) — даём заглушку.
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

  // ---------------------------------------------------------------- верхняя полоса и центр

  // Пространства Zen — в верхней полосе, как рабочие столы в Omarchy: у
  // пространства с иконкой — иконка, без неё — номер (у активного — точка).
  // Все ячейки одного размера. В конце — Create Space. Клик переключает.
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
        // Форма создания Zen находится в панели вкладок: показываем её заранее.
        KitLayout.show("tabs");
        document.getElementById("cmd_zenOpenWorkspaceCreation")?.doCommand();
      });
      box.replaceChildren(...buttons, create);
    };
    window.addEventListener("ZenWorkspacesUIUpdate", render);
    window.addEventListener("ZenWorkspaceDataChanged", render);
    ws.addChangeListeners?.(render);
    render();
    setTimeout(render, 1000); // пространства могут дочитаться после старта
  }

  // Create Folder — в конце раздела с папками, над линией Clear. Прямо в раздел
  // не кладём: по числу его детей Zen считает закреплённые вкладки
  // (перетаскивание, сессия). Кладём первой строкой в контейнер самой линии
  // (.pinned-tabs-container-separator) — его содержимое Zen не считает; линия с
  // Clear переносится строкой ниже (CSS).
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
    // новые пространства и пересборка их разметки
    window.addEventListener("ZenWorkspacesUIUpdate", add);
    window.addEventListener("ZenWorkspaceDataChanged", add);
    const holder = document.querySelector("zen-workspace")?.parentNode;
    if (holder) {
      new MutationObserver(add).observe(holder, { childList: true });
    }
  }

  // Анимация загрузки: Zen запускает «файл летит в загрузки» к кнопке
  // «Библиотеки» (#zen-library-button) или загрузок Firefox, а их у нас нет —
  // файл улетал в нижний угол окна. Цель Zen выбирает в начале
  // initializeAnimation (синхронно, приватным методом) через getElementById —
  // на время этого вызова подставляем значок Downloads на нашем тулбаре.
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
          return original.apply(this, args); // значок не виден — как у Zen
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

  // Группа страницы — назад/вперёд/обновить, адресная строка, зум, полный
  // экран, Split — по центру
  // окна. Свободное место CSS делит поровну (auto-поля, см. kit-layout.uc.css),
  // но слева от группы пространства, справа другие кнопки — ширина разная, и
  // группа съезжала. Меряем, насколько, и компенсируем отступом полосы.
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
      // отступ 2s с одной стороны сдвигает группу с auto-полями на s
      target.style.setProperty("--kit-nav-pad-start", `${Math.max(0, 2 * shift)}px`);
      target.style.setProperty("--kit-nav-pad-end", `${Math.max(0, -2 * shift)}px`);
    };
    const schedule = () => requestAnimationFrame(update);
    new ResizeObserver(schedule).observe(document.getElementById("kit-titlebar"));
    window.addEventListener("resize", schedule);
    setTimeout(schedule, 500);
    schedule();
  }

  // Раскрытую адресную строку Zen ставит поверх окна с top: -2px, считая её
  // прижатой к верху окна; меряем, где стоит полоса адреса, чтобы поправить.
  function setupCenter(navbar) {
    const update = () => {
      const rect = navbar.getBoundingClientRect();
      browserBox.style.setProperty("--kit-navbar-top", `${Math.round(rect.top)}px`);
      // где стоит закрытая строка внутри полосы адреса — для мода urlbar-dropdown,
      // чтобы раскрытая осталась ровно на месте (Zen ставит её с top: -2px)
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

  // Разделить вкладку в фокусе на две: side — right / left / top / bottom.
  // Это split view самого Zen (gZenViewSplitter): в новую половину открывается
  // новая вкладка, курсор — в адресной строке. Если вкладка уже в разделённом
  // экране, делится именно её панель.
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
        const before = side === "left" || side === "top"; // новая половина первой
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

  // Крестик в мини-меню панели разделённого экрана (появляется при наведении):
  // закрывает вкладку этой панели. Мини-меню Zen строит в _createHeader —
  // дополняем его, а заодно уже открытые.
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

  // Кнопка Split — обычная кнопка панели (CustomizableUI, двигается в Customize
  // Toolbar); по клику — меню: Add Right / Left / Top / Bottom Split.
  // Иконка — по мотивам Material Symbols Light «add-column-left-outline-rounded»:
  // рамка, подсвеченная новая колонка и крупный плюс (в оригинале плюс мелкий и
  // тонкий — в меню не читался). Повёрнута к стороне новой панели.
  const SPLIT_SIDES = [
    ["right", "Add Right Split"],
    ["left", "Add Left Split"],
    null,
    ["top", "Add Top Split"],
    ["bottom", "Add Bottom Split"],
  ];

  // Меню на macOS нативное: рисует только картинку из атрибута image, CSS
  // (маски, фон) не видит. Цвет текста меню попадает в иконку через
  // context-fill/context-stroke — это работает лишь для chrome://-файлов.
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
      // уже создан в другом окне
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
    // Проверяем выбранную группу при каждом открытии: после закрытия панели
    // или перехода в другую вкладку пункты снова становятся доступны.
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

    // onCommand у виджета в Zen не вызывается — ловим команду на окне
    // (так кнопка работает и после того, как Customize Toolbar её пересоздаст)
    window.addEventListener(
      "command",
      event => {
        if (event.target?.id === "kit-split") {
          menu.openPopup(event.target, "after_end");
        }
      },
      true
    );

    // один раз: вместо прежних двух кнопок Split right / Split down — одна,
    // на том же месте (сразу после полноэкранного режима)
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

  // Зум, полноэкранный режим и список вкладок — в строку адреса, а не отдельной
  // строкой под ней. Один раз: дальше расположение можно менять в Customize Toolbar.
  function mergeNavbarTools() {
    if (!window.CustomizableUI) {
      return;
    }
    // список всех вкладок не нужен — вкладки и так в панели Tabs (один раз)
    const ALLTABS = "kit.layout.alltabs-removed";
    if (!Services.prefs.getBoolPref(ALLTABS, false)) {
      try {
        CustomizableUI.removeWidgetFromArea("alltabs-button");
      } catch (e) {}
      Services.prefs.setBoolPref(ALLTABS, true);
    }
    // кнопки назад/вперёд/обновить относятся к странице — вплотную к адресу:
    // убираем пружину между ними и строкой (один раз)
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
      // в панели закладок остались только скрытые кнопки и нет закладок — прячем её
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

  // ---------------------------------------------------------------- запуск

  function init() {
    // Всплывающие окна сайтов (вход через Google, OAuth, оплата) — без раскладки:
    // в них Zen прячет панели, и перенесённые кнопки окна было бы не видно —
    // окно нечем закрыть. Оставляем их обычными окнами Zen.
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

    // Верхняя полоса: кнопки окна (светофор macOS, Zen держит их в панели
    // вкладок — переносим, чтобы не уезжали вместе с ней) и пространства.
    const titlebar = el("div");
    titlebar.id = "kit-titlebar";
    const windowButtons = toolbox.querySelector(".titlebar-buttonbox-container");
    if (windowButtons) {
      windowButtons.id = "kit-window-buttons";
      titlebar.append(windowButtons);
    }
    const workspaces = el("div");
    workspaces.id = "kit-workspaces";
    // навигация и адресная строка — тоже в верхней полосе, на всю её ширину:
    // центр остаётся только сайту
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
    // В Zen лимит зашит в MAX_TABS, отдельной настройки нет.
    // Поднимаем его для всех способов разделения, включая меню и перетаскивание.
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
