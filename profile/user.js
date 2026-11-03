// user.js — browser prefs applied on every Zen startup.
//
// Note: values here override whatever is set in Settings
// or about:config. If you want to change a pref by hand in the UI,
// don't add it here (or remove the line and restart Zen).
//
// Zen prefs with their defaults: zen-source/prefs/zen/*.yaml

// Enables userChrome.css and userContent.css (off by default in Zen).
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);

// Enables the Browser Toolbox — an inspector for the browser's own UI
// (Cmd+Opt+Shift+I on macOS): shows element ids and classes, lets you edit
// userChrome.css live in the Style Editor tab.
user_pref("devtools.chrome.enabled", true);
user_pref("devtools.debugger.remote-enabled", true);

// Navigation and the address bar as a separate toolbar, not inside the tab panel:
// the window layout (kit-layout.uc.js) moves that toolbar into the top bar.
user_pref("zen.view.use-single-toolbar", false);

// ---- Zen appearance (uncomment and change if needed) ----

// While typing, the address bar expands in place, downward below the bar, instead
// of as a large floating panel in the middle of the window. Options: "normal",
// "floating-on-type" (Zen default — floats up while typing), "float" (right on click).
user_pref("zen.urlbar.behavior", "normal");

// Corner radius in pixels; -1 follows the system.
// user_pref("zen.theme.border-radius", -1);

// Margin around the page in pixels (0–12).
// user_pref("zen.theme.content-element-separation", 8);

// ---- AI assistant (JS/kit-ai.uc.js) ----

// Claude model for the assistant panel: "opus", "sonnet" or a full name.
// Defaults to the one selected in Claude Code.
// user_pref("kit.ai.model", "opus");

// ChatGPT model (subscription sign-in). Defaults to the first one available to the account.
// user_pref("kit.ai.openai-model", "gpt-6.1-sol");
// How hard ChatGPT thinks: "low", "medium", "high".
// user_pref("kit.ai.openai-effort", "medium");

// ---- Links: no new windows; links from a page open in a split on the right (JS/link-split.uc.js) ----

// Links and window.open calls with window sizes open as a tab, not a separate
// window (default 2 — such site "popup" windows multiplied Zen windows).
// target=_blank links open in a tab of the current window (was 2 — every such
// link opened a new Zen window; 2 is set by the Zen settings checkbox
// "Open links in new windows", user.js overrides it).
user_pref("browser.link.open_newwindow", 3);
user_pref("browser.link.open_newwindow.restriction", 0);
// Zen itself opened links from pinned tabs to another site in Glance
// (default true). Preview only via the "Open Link in Glance" menu item.
user_pref("zen.glance.open-essential-external-links", false);
