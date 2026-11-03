# Zendo personal layer

Everything here is yours: Zendo updates (`bin/update`) don't touch this
folder. The folder is a separate git repository, so any change can be
reverted.

```
themes/*.css        your themes        → bin/theme <name>
mods/*.css          your mods          → bin/mod on <name>
sites/*.css         site styles        → bin/site on <name>
JS/*.uc.js          your scripts       (after restarting Zen)
CSS/*.uc.css        styles for scripts
user.js             your about:config preferences
userChrome.css      small UI tweaks
userContent.css     small page tweaks
AGENTS.md           personal instructions for the AI assistant
extensions.md       Chrome extensions and their replacements
current/            chosen theme, enabled mods and sites — written by bin/theme,
                    bin/mod, bin/site; do not edit by hand
```

A file with the same name as one in Zendo replaces it: for example, your own
`mods/hide-tab-close.css` instead of the built-in one.

Added or removed a file — run `bin/sync` from the Zendo folder (bin/mod,
bin/theme and launching via Zendo.app do it themselves).
