// user.js — настройки браузера, которые применяются при каждом запуске Zen.
//
// Важно: значения отсюда перезаписывают то, что выставлено в настройках
// или в about:config. Если хочешь менять настройку руками в интерфейсе —
// не добавляй её сюда (или удали строку и перезапусти Zen).
//
// Список настроек Zen с значениями по умолчанию: zen-source/prefs/zen/*.yaml

// Включает userChrome.css и userContent.css (в Zen по умолчанию выключено).
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);

// Включает Browser Toolbox — инспектор интерфейса самого браузера
// (Cmd+Opt+Shift+I на macOS): видно id и классы элементов, можно править
// userChrome.css вживую во вкладке Style Editor.
user_pref("devtools.chrome.enabled", true);
user_pref("devtools.debugger.remote-enabled", true);

// ---- Внешний вид Zen (раскомментируй и поменяй, если нужно) ----

// Адресная строка при вводе раскрывается на месте, вниз под строкой, а не
// большой плавающей панелью посреди окна. Варианты: "normal",
// "floating-on-type" (по умолчанию в Zen — всплывает при вводе), "float" (сразу при клике).
user_pref("zen.urlbar.behavior", "normal");

// Скругление углов в пикселях; -1 — как принято в системе.
// user_pref("zen.theme.border-radius", -1);

// Отступ вокруг страницы в пикселях (0–12).
// user_pref("zen.theme.content-element-separation", 8);

// ---- ИИ-помощник (JS/kit-ai.uc.js) ----

// Модель Claude для панели помощника: "opus", "sonnet" или полное имя.
// По умолчанию — та, что выбрана в Claude Code.
// user_pref("kit.ai.model", "opus");

// Модель ChatGPT (вход по подписке). По умолчанию — первая из доступных аккаунту.
// user_pref("kit.ai.openai-model", "gpt-6.1-sol");
// Сколько ChatGPT думает: "low", "medium", "high".
// user_pref("kit.ai.openai-effort", "medium");

// ---- Ссылки: без новых окон, со страницы — сплитом справа (JS/link-split.uc.js) ----

// Ссылки и window.open с размерами окна открываются вкладкой, а не отдельным
// окном (по умолчанию 2 — такие «всплывающие» окна сайтов множили окна Zen).
// Ссылки с target=_blank — во вкладке текущего окна (было 2 — каждая такая
// ссылка открывала новое окно Zen; 2 ставит галочка в настройках Zen
// «Open links in new windows», user.js её перебивает).
user_pref("browser.link.open_newwindow", 3);
user_pref("browser.link.open_newwindow.restriction", 0);
// Ссылки из закреплённых вкладок на другой сайт Zen сам открывал в Glance
// (по умолчанию true). Превью — только пунктом меню «Open Link in Glance».
user_pref("zen.glance.open-essential-external-links", false);
