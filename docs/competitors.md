# Аналітика конкурентів: Session Sync for Claude Code (дата: 2026-11-13)

Примітка щодо перевірки: дані зі сторінок GitHub/docs.rs/PyPI. «Не підтверджено» = сторінка не показала. Дат останніх комітів сторінки не показували (крім clync 0.4.1 — 2026-08-10, ahmojo — канарейка 2026-10-07).

## Огляд знайдених продуктів

| Продукт | Автор | Зірки / установки | Як працює | Транспорт | Шифрування | Платформи | Сильне | Слабке |
|---|---|---|---|---|---|---|---|---|
| tawanorg/claude-sync (npm @tawandotorg/claude-sync, v1.11.1) https://github.com/tawanorg/claude-sync | tawanorg | 324 зірки, 54 форки, 29 відкритих issues | CLI push/pull/diff/conflicts, gzip+age, мапінг шляхів | Cloudflare R2, S3, GCS, S3-сумісні, WebDAV | age + Argon2 (парольна фраза) | npm/Go/бінарі (macOS ARM підтверджено) | Найпопулярніший, шифрування, конфлікти як .conflict, hooks авто-push/pull | history.jsonl last-writer-wins; втрата фрази = втрата даних; без GUI |
| perfectra1n/claude-code-sync https://github.com/perfectra1n/claude-code-sync | perfectra1n | 103 зірки, 21 форк | Rust CLI, bidirectional sync | git (+Mercurial), LFS | Немає (радять шифрувати репо) | Linux, macOS, Windows | Розумний merge по дереву UUID, 3-way для артефактів, undo, deny-list секретів, мапінг проєктів | Без шифрування; undo лише останній pull/push |
| ahmojo/codex-claude-transfer (cct) https://github.com/ahmojo/codex-claude-transfer | ahmojo | 81 зірка, 10 форків | Export у .codexbundle, import на іншій машині; TUI та локальний веб-застосунок; крос-агентний handoff Codex<->Claude | Вручну (файл), LAN, git | age (опційно) | Windows/macOS/Linux | Без хмари; Codex+Claude; контрольні суми | Ручне перенесення; формати можуть зламатися |
| Daniel-de-Oliveira-Trindade/claude-context-sync (розширення DaleuStudio.claude-context-sync) https://github.com/Daniel-de-Oliveira-Trindade/claude-context-sync | Daniel de Oliveira Trindade | 13 зірок; установки розширення не підтверджено | Python CLI + VS Code розширення (бічна панель, авто-синхронізація) | git (SSH/HTTPS) або власний FastAPI-сервер | AES-256-GCM (PBKDF2), опційно | Повністю протестовано на Windows | Найближчий прямий конкурент (VS Code), авто-sync, шарінг | Без розв'язання конфліктів; потребує claude-sync у PATH |
| Saturate/clync (v0.4.1, 2026-08-10) https://github.com/Saturate/clync | Saturate | 1 зірка | Rust CLI, MCP-сервер (8 інструментів) | git (LFS), тека/NAS, S3 | age: ключ-файл, фраза, 1Password, Bitwarden, pass | Не підтверджено | Merge по дереву UUID, зручні сховища ключів | Дуже малий; платформи не вказані |
| geekmuse/chronicle (v0.9.1) https://github.com/geekmuse/chronicle | Brad Campbell | 4 зірки | Rust CLI, канонізація шляхів {{SYNC_HOME}}, CRDT (set-union) для JSONL | git (SSH) | Не підтверджено | Linux, macOS (Windows не згадано) | Pi + Claude Code, частково N останніх сесій | Альфа, ризик втрати даних |
| emreonal11/claude-code-migrate https://github.com/emreonal11/claude-code-migrate | emreonal11 | 5 зірок | Скрипти rsync/sed, перепризначення шляху | Вручну | Немає | macOS (Linux не перевірено) | Підказка про cleanupPeriodDays (за замовчуванням 30 днів) | Ручне, 3 коміти |
| claude-session-sync (PyPI) https://pypi.org/project/claude-session-sync/ | не підтверджено (сторінка не відкрилась, 404) | не підтверджено | За описом пошуку: копіює в приватний GitHub-репо, заміна шляхів на плейсхолдери, демон | GitHub | не підтверджено | Windows/macOS/Linux | — | Збіг назви з нашою; факти не перевірені |
| workromancer/clsync https://github.com/workromancer/clsync | workromancer | 8 зірок | Синхронізує налаштування/skills/agents (не сесії) через GitHub; MCP 37 інструментів | GitHub | Не згадано | не підтверджено | Налаштування, а не історія | Не про сесії |
| SpecStory https://docs.specstory.com/cloud/sync-and-store | SpecStory (компанія) | не підтверджено | Розширення/CLI зберігають чати як Markdown, опційно хмарний sync, пошук, шарінг | Власна хмара | не підтверджено | VS Code-подібні редактори, CLI | Крос-IDE, авто | Закрита хмара; експорт у Markdown, а не resume |
| Claudian Session Sync (Obsidian) https://community.obsidian.md/plugins/claudian-session-sync | не підтверджено | не підтверджено | Плагін Obsidian | — | — | — | Нішевий | Деталі не перевірено |
| Glama «Claude Session Sync» (MCP) https://glama.ai/mcp/servers/ehpj1f6ko5 | не підтверджено | не підтверджено | Заявлено E2E-шифрування | — | Заявлено E2E | — | — | Не перевірено |
| VS Code 1.123 «portable AI session history» (червень 2026) https://feedbagel.com/post/vs-code-1123-turns-ai-sessions-into-project-memory | Microsoft | — | Вторинне джерело, дуже коротке; охоплення (Copilot чи й Claude Code) не підтверджено | — | — | — | Потенційний системний конкурент | Не підтверджено, чи працює для Claude Code |

Не знайдено/не підтверджено: сторінки у VS Code Marketplace та Open VSX для конкурентів з кількістю установок (Marketplace напряму не відкрився). rexdotsh.claudesync — це синхронізація коду з Claude.ai Projects, не сесій. Cursor/Codex-історія: окремих перевірених синхронізаторів знайдено лише cct (Codex+Claude).

Контекст ринку: Anthropic офіційної синхронізації немає. Запит anthropics/claude-code#72578 (вбудований cloud sync історії) відкритий 2026-06-30 і автоматично закритий як «not planned» 2026-08-20 (за неактивність, 3 реакції); тобто вирішення з боку Anthropic найближчим часом не очікується.

## Порівняння з нашим розширенням

| Можливість | Ми (0.8.0) | claude-sync | claude-code-sync | cct | context-sync | clync |
|---|---|---|---|---|---|---|
| GUI у VS Code | так | ні | ні | ні (TUI/веб) | так | ні |
| GitHub | так | ні | git | git | git | git |
| iCloud/Dropbox/OneDrive/GDrive/інші | так (прямий Dropbox/OneDrive OAuth + тека) | ні | ні | ні | ні | тека |
| S3/R2/WebDAV | ні | так | ні | ні | ні | S3 |
| Шифрування | немає | age | немає | age | AES-GCM | age |
| Авто-синхронізація | ні | hooks | ні | ні | так | ні |
| Merge сесій | ні (конфлікт, без перезапису) | .conflict | так (UUID-дерево) | merge (LAN) | ні | так |
| Мапінг шляхів між ПК | projectKey (ідентифікація проєкту); перепис шляхів не підтверджено в README | так | так | так | так | не підтверджено |
| Вибір пристрою/сесій | так | частково | так | так | так | не підтверджено |
| Експорт окремою папкою на пристрій | так | ні | ні | bundle | ні | ні |
| CLI / MCP | ні | CLI | CLI | CLI | CLI | CLI+MCP |
| Усі проєкти одразу | ні (лише поточний) | так | так | так | так | так |
| Інші IDE (Cursor) / агенти | ні | ні | ні | Codex | ні | ні |

## Прогалини
1. Шифрування (age/парольна фраза) — є у 4 з конкурентів; у нас сесії можуть містити секрети.
2. Merge сесій по дереву UUID замість лише виявлення конфлікту.
3. Автосинхронізація (на старті/закритті, за таймером).
4. Лише поточний проєкт; немає «синхронізувати всі проєкти».
5. Немає CLI (для Cursor/термінала/SSH-середовищ) та MCP.
6. Не синхронізуються CLAUDE.md, memory, skills, налаштування (конкуренти — частково).
7. Немає S3/WebDAV; немає OAuth у віддалених вікнах (SSH/WSL) — відомий мінус.
8. Немає виявлення секретів (deny-list) перед push.
9. Немає ретеншн-підказки: cleanupPeriodDays=30 видаляє старі сесії.

## Наші переваги
- Єдине з перевірених рішень із прямим входом у Dropbox/OneDrive без десктопного клієнта та підтримкою iCloud/GDrive/MEGA/pCloud/Box/Proton/Nextcloud.
- Повноцінний GUI у VS Code: вибір пристрою, вибір сесій зі списком (назва, дата, розмір, статус), Resume одним кліком.
- Окрема папка на пристрій, видалення експорту, перевірка конфлікту імен пристроїв, повтори й зрозумілі помилки, локалізація (4 мови).
- Не потребує власного сервера, ключів S3 чи CLI; мінімальний поріг входу.

## Пріоритезовані рекомендації
1. (Високий) Сквозне шифрування з парольною фразою (age/AES-GCM, Argon2/scrypt) для всіх методів; опційно прапорець.
2. (Високий) Скан секретів перед push (шаблони ключів/токенів) із попередженням/маскуванням.
3. (Високий) Merge по UUID-дереву для розбіжних сесій (замість відмови).
4. (Середній) Автосинхронізація: pull при відкритті проєкту, push при закритті/за таймером, з перемикачем.
5. (Середній) Режим «усі проєкти» + мапінг шляхів (перепис абсолютних шляхів) для різних home-каталогів.
6. (Середній) Окремий CLI/npx-бінарник, щоб працювати з Cursor, SSH, Codespaces; той самий формат сховища.
7. (Середній) Синхронізація CLAUDE.md/memory/skills/налаштувань (опційні категорії, deny-list для токенів).
8. (Низький) S3/WebDAV-транспорти; MCP-сервер; підказка про cleanupPeriodDays; підтримка Cursor (той самий формат ~/.claude).
9. Моніторити VS Code «portable AI session history» (1.123) — перевірити, чи покриває Claude Code.
