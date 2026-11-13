# Аналіз коду Session Sync for Claude Code (v0.8.0)

Метод: прочитано весь src/extension.ts, src/core/*.ts, package.json, README.md, CHANGELOG.md. Проєкт не змінювався.
Позначка [перевірити] означає, що висновок випливає з документації VS Code/сервісу, а не лише з коду.

## 1. Реальні баги

### 1.1 HIGH. Невдалий git push ніколи не доштовхується (src/core/git.ts:74-79, syncService.ts:85-109)
`commitAndPush` повертає `false`, якщо `git status --porcelain` порожній, і не перевіряє непушені коміти.
Сценарій: коміт створено, `git push` упав (мережа, гонка з іншим пристроєм). Повторна спроба (цикл у push, attempt 2)
робить `refresh` (pull --rebase), `copyTranscripts` нічого нового не копіює, status чистий, повертається `false`.
UI каже «nothing new to push», хоч віддалений репозиторій не має даних. Те саме при наступному ручному Push.
Це робить «retry once after lost race» (syncService.ts:84) недієвим для github/git.
Виправлення: після `status` перевіряти `git rev-list @{u}..HEAD --count` (або `git status -sb` ahead) і пушити, якщо є ahead-коміти;
якщо upstream немає, пушити, коли є коміти. Додати тест із фейковим remote, що відхиляє перший push.

### 1.2 HIGH. Застарілий знімок конфігурації після `cfg.update` (extension.ts:524-526, 688-697, 137-158)
`WorkspaceConfiguration` є знімком [перевірити]. У `reconnect` (folder): `cfg.update('syncFolder','')`, далі `folderTransport(cfg)`
читає `cfg.get('syncFolder')` зі старого знімка, тож повертає `FolderTransport(старий шлях)` без запиту.
Кнопка «Choose the storage again» нічого не робить, повтор падає з тією ж помилкою.
У команді `chooseMode` (688-697): `chooseMode(cfg,true)` очищає `syncFolder`, а `folderTransport(cfg)` знову бачить старе значення.
Коментар на рядку 155 («the folder of the previous cloud storage must not be reused») порушується.
Виправлення: після update брати `vscode.workspace.getConfiguration(SECTION)` заново, або передавати в `folderTransport` явний параметр `reset`.

### 1.3 MEDIUM. `chooseMode` зберігає метод ДО налаштування (extension.ts:154-156, 695)
Користувач обирає Dropbox, скасовує вхід у браузері: `mode='dropbox'` уже записано, `syncFolder` стерто, попередній метод втрачено,
статус-бар показує «Dropbox», хоча нічого не підключено. Те саме для `git` без `repoUrl` (повідомлення «now using your git repository»).
Виправлення: записувати mode лише після успішного `cloudTransport/folderTransport`; або відкочувати до попереднього значення.

### 1.4 MEDIUM. «Resume» тягне весь транспорт (extension.ts:758-776, 573-586)
Команда `resume` проходить `openSession`, тобто `githubTransport` (getSession + 2 HTTP-виклики), `cloudTransport` (вхід), перевірку `repoUrl`,
хоча потрібні лише локальні файли. Офлайн/без входу Resume дає «cannot reach the storage» або запит входу.
Якщо `mode` не вибрано, Resume питає метод синхронізації.
Виправлення: окремий шлях без транспорту (лише `folder`, `claudeDir`, `localDir`).

### 1.5 MEDIUM. Resume ігнорує `claudeDir` (extension.ts:773-775)
Терміналу не передається `CLAUDE_CONFIG_DIR`, коли задано `claudeDir`; `claude --resume <id>` шукає в `~/.claude`: «No conversation found».
Виправлення: `createTerminal({ env: { CLAUDE_CONFIG_DIR: ... } })`, коли `claudeDir` непорожній.

### 1.6 MEDIUM. Блокування «одна операція» не працює між командами (syncService.ts:65-68, 215-219; extension.ts:556-610)
`SyncService.exclusive` черга живе в екземплярі, а `openSession` створює новий `SyncService` на кожну команду, тож черга нічого не захищає.
Залишається `busySince` у `command()` зі staleness 10 хв: довгий upload (>10 хв) або діалог без відповіді дозволяє другу операцію
паралельно у тому ж кеші (git index corruption, на що посилається коментар). `disconnect`, `chooseMode`, `manage` не перевіряють lock:
`disconnect` видаляє кеш (`fs.rmSync`, 720) під час активного push.
Виправлення: один модульний/глобальний mutex (SyncService-синглтон на кеш-директорію), без таймауту-«stale», а з відстеженням живого promise; disconnect теж чекає.

### 1.7 MEDIUM. Збереження `takeOver` не потрапляє у Dropbox/OneDrive (remote.ts:89, syncService.ts:183-200)
`MirrorTransport.publish` вирішує про upload лише за розміром. `device.json` = `{"id":<uuid>,"name":...}` має однакову довжину для будь-якого uuid,
тому перезаписаний маркер після «This is the same computer» не завантажується. Після очищення кешу (Disconnect) старий маркер
знову стягується, і конфлікт імені повторюється; старий комп'ютер лишається власником. Також refresh порівнює лише розмір:
змінений файл тієї ж довжини не оновиться локально.
Виправлення: порівнювати також content_hash (Dropbox) / hash (OneDrive `file.hashes`) або mtime, або для маркера додати лічильник/timestamp (змінює розмір).

### 1.8 MEDIUM. Нестабільна ідентичність пристрою за замовчуванням (extension.ts:342)
`os.hostname()` на macOS змінюється з мережею («MacBook-Pro.local», «MacBook-Pro-2.local», «.lan»). Новий хост дає нову папку `devices/<name>`
без клешу (різний `name`, той самий installId): експорти осиротіють, у списку пристроїв з'являться дублі.
Загальні імена («MacBook-Pro») на двох машинах дають клеш. Нелатинська назва хоста стає `device` (devices.ts:13-21), тож дві такі машини зіткнуться.
Виправлення: на першому використанні згенерувати й зберегти ім'я (hostname + короткий installId) у globalState/налаштуванні; не вирізати нелатиницю в `device`, а транслітерувати або додавати суфікс installId.

### 1.9 MEDIUM. OAuth-колбек: будь-який запит із невірним state перериває вхід (oauth.ts:122-135)
Достатньо одного запиту на `http://127.0.0.1:53682/callback` без/з чужим `state` (інша вкладка, локальний процес, сканер), і `finish(CloudAuthError)`
закриває сервер: вхід скасовано (DoS). Виправлення: на невірний state відповідати 400 і продовжувати чекати, завершувати лише на валідний state або на `error=` із коректним state.
Також `server.close()` не розриває keep-alive з'єднання: порт лишається зайнятим кілька секунд, повторний вхід дає EADDRINUSE; використати `closeAllConnections()` (Node 18.2+).
Фіксовані порти 53682/53683 ламаються при двох вікнах VS Code; Dropbox вимагає зареєстрований redirect, тож порт змінити не можна, але повідомлення можна зробити зрозумілішим.

### 1.10 MEDIUM. 401 від API трактується як «вийшов з акаунта» без спроби оновити токен (dropbox.ts:43, onedrive.ts:59, oauth.ts:90-99)
`CloudAuthError` кидається одразу; закешований access-token міг застаріти раніше за `expires_in` (різниця годинників, відкликання). Користувачу пропонується «Sign in again» і видаляється refresh-token (extension.ts:538-541),
хоча достатньо інвалідувати кеш і повторити запит один раз. Виправлення: `tokenProvider.invalidate()` і один retry при 401.

### 1.11 MEDIUM. Помилки git можуть містити облікові дані з `repoUrl` (git.ts:14, 41, 44; extension.ts:591-602, 166)
`REPO_URL` дозволяє `https://user:token@host/...`. Повідомлення `execFile` («Command failed: git clone -- https://user:token@...») іде в Output-канал (`log.error`) і в toast; `describeMethod` теж показує `repoUrl` у повідомленнях. Також URL з токеном потрапляє у `.git/config`.
Виправлення: відхиляти URL з userinfo (`user:pass@` для https), маскувати `://[^@/]+@` у `log`/toast.

### 1.12 MEDIUM. Переоформлена помилка автентифікації git як «мережа» (errors.ts:4, extension.ts:101-104, 597)
`isAccessError` не ловить `fatal: unable to access '...': The requested URL returned error: 403` (формат git), а `classifyError` бачить `unable to access` і каже «cannot reach the storage, check internet». Протухлий/недостатній токен подається як проблема мережі.
`permission denied` у `isAccessError` ловить і локальні EACCES (запис у `~/.claude/projects`), пропонуючи «Sign in to GitHub». `sign.?in` матчить майже будь-що.
Виправлення: типізовані помилки (CloudAuthError, GitAuthError з exit-code/stderr-аналізу), а не регекси по тексту.

### 1.13 MEDIUM. Rebase-конфлікт назавжди ламає git-кеш (git.ts:53-56)
`pull --rebase --autostash` при конфлікті лишає репозиторій у стані rebase; усі наступні операції падають. Автовідновлення немає.
Також зміна `repoUrl`/GitHub-акаунта виконує лише `remote set-url` (git.ts:47-49) на вже існуючому клоні з іншою історією: `pull --rebase` на непов'язаній історії.
Виправлення: при помилці pull робити `rebase --abort` + `reset --hard origin/<branch>` (кеш одноразовий, дані локальних сесій не страждають), при зміні URL перестворювати клон.
Пов'язано: порожній/частково клонований каталог `.git` після обриву clone (git.ts:42) лишає зламаний кеш.

### 1.14 MEDIUM. Windows: регістр літери диска й довгі шляхи (paths.ts:5, extension.ts:320, 336)
`uri.fsPath` у VS Code на Windows повертає літеру диска в нижньому регістрі (`c:\...`), Claude Code кодує cwd як `C--...`. NTFS регістро-нечутлива, тож папка знайдеться, але створення `c--...` vs `C--...` на інших ФС/WSL розходиться. Також Claude Code для дуже довгих шляхів скорочує ім'я з хешем [перевірити], `encodeProjectDir` цього не робить.
Виправлення: нормалізувати літеру диска до верхнього регістру; звіряти з наявними каталогами в `projects/` (шукати існуючий за case-insensitive збігом).

### 1.15 LOW-MEDIUM. Усі `.jsonl` у каталозі проєкту вважаються сесіями (transcripts.ts:5, 206-221)
Regex `^[0-9a-zA-Z-]+\.jsonl$` пропускає `agent-xxxx.jsonl` (субагенти): вони експортуються й потрапляють у вибір як «(no prompt)»; `claude --resume agent-...` не працює. Також не синхронізуються пов'язані підкаталоги `<session-id>/` (tool-results, subagents) [перевірити для актуальних версій Claude Code], тож відновлена сесія може втратити частину контексту.
Виправлення: фільтрувати за UUID-шаблоном; задокументувати обмеження.

### 1.16 LOW-MEDIUM. Одна збійна операція файлу зриває весь push/pull (transcripts.ts:71-98, remote.ts:60-83)
Немає try/catch на файл: EBUSY/EPERM (Windows, відкритий файл), EACCES, зламаний symlink (`statSync`) переривають цикл, лишають tmp-файл `.x.tmp-<pid>`; hidden tmp ніколи не прибираються (walk пропускає hidden, `pruneEmptyDirs` не видалить каталог).
Виправлення: ізолювати помилки по файлах (збирати у `failed[]`), чистити tmp на старті refresh.

### 1.17 LOW. `isPrefix` не обробляє короткі читання (transcripts.ts:46-50)
`fs.readSync` може повернути менше байтів (мережеві/хмарні файлові системи); порівняння використовує `len`, тож хибний `conflict`. Виправлення: цикл читання до `len`.

### 1.18 LOW. Інші дрібні
- Dropbox `remove`: усі 409 вважаються «вже видалено» (dropbox.ts:96), приховує реальні помилки; розбирати `error_summary` (`path_lookup/not_found`).
- OneDrive: chunk-upload не обробляє 416/повтор із запитом `nextExpectedRanges` (onedrive.ts:112-121).
- `retryingFetch` повторює й `AbortError`; немає загального timeout для fetch (зависання на мертвому з'єднанні назавжди; прогрес не скасовується: `cancellable` не виставлено в `progress`, extension.ts:485).
- `githubAuthEnv` перезаписує `GIT_CONFIG_COUNT` користувача (github.ts:13-17).
- `ensurePrivateRepo` використовує `fetch` без retry і викликається на кожну команду (2-3 HTTP-запити).
- `safeDeviceName` дозволяє хвостову крапку й зарезервовані імена Windows (`con`, `nul`), та імена, що розрізняються лише регістром, зливаються на нечутливих до регістру ФС/Dropbox/OneDrive (devices.ts:13-21).
- `projectKey`: для GitLab-підгруп береться лише `sub/repo` (paths.ts:11), різні ключі `a/b_c` і `a_b/c` збігаються після санітизації; регістр.
- Шлях з `\` або `:` у назві з мережі на Windows обходить перевірку `..` (remote.ts:64): `path.join` трактує `\` як роздільник. Малоймовірно (Dropbox/OneDrive забороняють), але перевірку варто розширити.
- Symlink у git-репозиторії з іменем `*.jsonl` читається через `statSync` (копіює вміст цілі у `~/.claude/projects`). Використовувати `lstat`, пропускати symlink.

## 2. Безпека та приватність

- (Medium) Попередження про приватність лише одне, глобальне (`WARNED_KEY`, extension.ts:22, 350-359), і не прив'язане до місця призначення. Режим `git` не перевіряє приватність репозиторію (на відміну від `github`, де є API-перевірка), `folder` може бути спільною текою. Пропозиція: попередження на кожне нове призначення; для `git` з github.com-URL перевіряти `private` через API (якщо є токен).
- (Medium) Жодного сканування секретів перед відправкою (ключі `AKIA…`, `ghp_`, `-----BEGIN … PRIVATE KEY`). Транскрипти містять вивід команд. Пропозиція: попереджувальний (не блокувальний) скан із переліком збігів.
- (Low-Medium) Дані не шифруються, а `refresh` викачує ВЕСЬ app-каталог/весь репозиторій у globalStorage (усі пристрої й проєкти, remote.ts:60-83; git clone). Це надлишкові копії чужих транскриптів з інших проєктів. Пропозиція: тягнути лише `devices/*/projects/<key>`; для git sparse-checkout.
- (Low) `disconnect` видаляє кеш лише поточного режиму (extension.ts:719-720); кеші інших методів залишаються на диску з відкритими транскриптами (`CACHE_DIR` має 4 каталоги). Прибирати всі.
- (Low) OneDrive `common` authority + `Files.ReadWrite.AppFolder`: app-папка (`special/approot`) доступна лише для особистих акаунтів [перевірити]; робочий/навчальний акаунт отримає незрозумілу помилку. Розглянути `consumers` або явне повідомлення.
- Токени: refresh-токени у `context.secrets` (добре); access-токен тільки в пам'яті; GitHub-токен через env, не argv (добре); токени в логи не потрапляють. `failure()` пише до 200 символів тіла відповіді, прийнятно.
- Env `GIT_TERMINAL_PROMPT=0` не стосується ssh: запит passphrase / невідомого хоста не має tty, git висне або падає (немає `BatchMode=yes`/таймауту ssh-промпту; є загальний timeout 120 с).
- `isValidRepoUrl` дозволяє абсолютні локальні шляхи (`/...`), що суперечить тексту помилки (https, ssh, git@host) та README.

## 3. Мертвий код і розбіжності

| Місце | Що |
|---|---|
| extension.ts:648 | Команда `claudeSessionSync.showLog` зареєстрована, але відсутня в `package.json contributes.commands`: недоступна з палітри; доступна лише з кнопок. README про неї мовчить. |
| package.json `activationEvents: []` | Розширення активується лише після першої команди; статус-бар (extension.ts:633-640) і README («Click Claude Sync in the status bar») з'являються тільки після неї. Додати `onStartupFinished`. |
| README «Settings» | `mode` описано як «github, folder, git»: немає dropbox/onedrive; відсутні `syncFolder` і `claudeDir` (є в package.json). |
| README/Security | Не згадано, що Dropbox/OneDrive-токени зберігаються у secret storage і що `Disconnect` видаляє їх (згадано в CHANGELOG 0.6.0). |
| transcripts.ts:26,93 `CopyResult.skipped` | Заповнюється, у коді розширення не використовується (лише тест). Можна лишити як метрику у логах. |
| syncService.ts:151 `removeDevice().published` | Повертається, ніде не читається. |
| transport.ts FolderTransport.publish | `copied>0` як «pushed» відрізняється від git/Mirror (реальна зміна): `report` каже різне для різних методів (для git `pushed=false` може бути при copied>0, див. 1.1). |
| extension.ts:134 vs 66 | `isMode` і тип `Mode` дублюють перелік; `CACHE_DIR` дублює імена каталогів, що створюються в `githubTransport`(`'github-repo'`), `gitTransport`(`'repo'`), `cloudTransport`(`${id}-cache`) рядковими літералами в трьох місцях. Винести константу. |
| oauth.ts ↔ remote.ts | `CloudAuthError` оголошено в `remote.ts`, а імпортується з oauth.ts та клієнтів (шар перемішано). Винести в `errors.ts`. |
| errors.ts / extension.ts:101 | Дві паралельні системи класифікації помилок на регексах. |
| Dropbox/OneDrive | Код дублює `call/failure/401-обробку`; можна винести базовий клас. |
| extension.ts 780 рядків | Усе в одному файлі: UI-flow, транспорти, reconnect. Розбити на модулі. |
| Mode `github` vs `git` | Різні каталоги кешу, різна обробка помилок/реconnect, тоді як `GitTransport` той самий. |
| package.json | `mode` enum містить `""`, прийнятно. `description` називає Google Drive, але це лише через «Cloud folder» (узгоджено з README). |

## 4. Продуктивність і надійність

- (Medium) Синхронні важкі читання в extension host: `listSessions` читає до 4 МБ голови + 256 КБ хвоста КОЖНОЇ сесії при кожному відкритті пікера й навіть у `push` лише для перевірки «є сесії» (extension.ts:669). Сотні сесій блокують UI. Для push досить `readdir`; для пікера кешувати за (size, mtime) та читати асинхронно.
- (Medium) Pull робить три повні `refresh` (devices → available → pull): три `git pull`/ls-remote або три повні обходи OneDrive (рекурсивний обхід по одній папці: N+1 запит, onedrive.ts:73-87; можна `search`/delta). Кешувати refresh на час команди; фінальний refresh у pull лишити коротким.
- (Medium) Транскрипти пересилаються цілком при кожному дописуванні та не стискаються: gzip дав би порядок економії (git-репо швидко росте, ліміти GitHub/Dropbox-квота). Для git: shallow clone/`--depth 1` + періодичний squash.
- (Low) Pull-ed сесії при Push з іншого пристрою експортуються повторно під ім'ям цього пристрою (mtime = час pull, тож age-фільтр не діє): дублікати по N пристроях. Пропозиція: фільтр за `lastActivity`, не mtime, і пропуск сесій, що вже є в іншого пристрою ідентичними.
- (Low) Конфлікти лише звітуються (extension.ts:393-397): немає дії «зберегти копію з новим id» чи diff.
- (Low) `fetch` не враховує проксі VS Code [перевірити]; корпоративні мережі отримають «cannot reach the storage».
- (Low) `Uint8Array(data)` дублює пам'ять (до ~190 МБ на файл, dropbox.ts:89, onedrive.ts:100).
- (Low) Настройки `scope: machine`: у Remote-вікнах (SSH/WSL) вони читаються з remote-налаштувань, а README каже «User settings».
- UX: немає окремої команди/кнопки «Show log» у палітрі; немає індикатора обсягу (скільки буде завантажено); прогрес не скасовується; `Pull` для єдиного пристрою пропускає вибір (добре), але режим «Pull all» одним кліком не пропонується.
- Тести: є src/test (для core), extension.ts (780 рядків UI-логіки, reconnect, retry) без тестів; саме тут 1.2, 1.3, 1.6.

## Топ-10

1. HIGH git/github: непушений коміт ніколи не пушиться, retry після гонки не працює (git.ts:74).
2. HIGH Застарілий знімок `cfg` після update: «Choose the storage again»/«Choose sync method» повторно використовують старий `syncFolder` (extension.ts:524, 697).
3. MEDIUM `chooseMode` пише метод до підключення; скасування входу лишає зламаний стан (extension.ts:154, 695).
4. MEDIUM Блокування операцій неефективне (новий SyncService на команду, stale-таймер 10 хв, disconnect без lock) (extension.ts:556; syncService.ts:215).
5. MEDIUM Resume вимагає транспорт/мережу/вхід і ігнорує `claudeDir` (extension.ts:758-776).
6. MEDIUM Облікові дані з `repoUrl` потрапляють у лог/toast/.git/config; є розбіжність класифікації помилок (git 403 як «мережа») (git.ts:14; errors.ts:4).
7. MEDIUM Нестабільне/колізійне ім'я пристрою за замовчуванням (hostname, нелатиниця -> `device`) і `takeOver` не зберігається у Dropbox/OneDrive через порівняння за розміром (extension.ts:342; remote.ts:89).
8. MEDIUM OAuth-колбек перериває вхід на будь-якому запиті без валідного state; 401 без повтору оновлення токена (oauth.ts:122; dropbox.ts:43).
9. MEDIUM Приватність: одноразове глобальне попередження, немає перевірки приватності для `git`, немає сканування секретів, повне завантаження чужих проєктів у кеш, залишені кеші після Disconnect.
10. MEDIUM Продуктивність і активація: синхронне читання всіх сесій у extension host, три refresh на Pull, `activationEvents: []` (статус-бар не з'являється до першої команди), `showLog` не в package.json; README розходиться з налаштуваннями.
