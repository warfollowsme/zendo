# Личный слой Zendo

Всё, что здесь лежит, — твоё: обновления Zendo (`bin/update`) эту папку не
трогают. Папка — отдельный git-репозиторий, так что любую правку можно
откатить.

```
themes/*.css        свои темы        → bin/theme <имя>
mods/*.css          свои моды        → bin/mod on <имя>
sites/*.css         стили сайтов     → bin/site on <имя>
JS/*.uc.js          свои скрипты     (после перезапуска Zen)
CSS/*.uc.css        стили к скриптам
user.js             свои настройки about:config
userChrome.css      мелкие правки интерфейса
userContent.css     мелкие правки страниц
AGENTS.md           личные указания для ИИ-помощника
extensions.md       расширения из Chrome и чем их заменить
current/            выбранная тема, включённые моды и сайты — пишут bin/theme,
                    bin/mod, bin/site; руками не правь
```

Файл с тем же именем, что у Zendo, заменяет его: например, свой
`mods/hide-tab-close.css` вместо встроенного.

Добавил или удалил файл — запусти `bin/sync` из папки Zendo (bin/mod,
bin/theme и запуск через Zendo.app делают это сами).
