# Session Sync for Claude Code

[English](README.md) · [Українська](README.uk.md) · **Español** · [简体中文](README.zh-CN.md)

> Extensión comunitaria no oficial. No está afiliada ni respaldada por Anthropic. «Claude» y «Claude Code» son marcas de Anthropic.

Continúa una sesión de Claude Code en otro dispositivo. La extensión traslada el historial de tus sesiones entre tus
equipos sin servidor propio: los datos viajan por algo que ya usas.

## Cómo se usa

Los comandos están en la Paleta de comandos: **Cmd+Shift+P** (Windows y Linux: Ctrl+Shift+P) y escribe «Claude Sync».

### En el dispositivo donde trabajaste

1. Abre el proyecto en VS Code.
2. Ejecuta **Claude Sync: Push sessions**.
3. La primera vez elige cómo viajan las sesiones (ver abajo). La extensión hace el resto.

### En el dispositivo donde continúas

1. Instala la extensión y abre **el mismo proyecto** (mismo remoto de git).
2. Ejecuta **Claude Sync: Pull sessions** y elige el mismo método.
3. Elige **desde qué dispositivo** importar (se omite si solo otro dispositivo ha exportado).
4. Aparece la lista de sesiones de ese dispositivo: título, fecha, tamaño y estado. Marca las que necesites o pulsa «Select all».
5. Ejecuta **Claude Sync: Resume a session**, elige una y se abre una terminal con `claude --resume`.

### Reglas prácticas

- **Haz Push antes de dejar un dispositivo y Pull antes de empezar en otro.**
- No continúes una misma sesión en dos dispositivos a la vez: la extensión avisa del conflicto y no sobrescribe nada.
- Una sesión traída puede no aparecer enseguida en la lista de sesiones de Claude Code. Recarga la ventana (**Developer: Reload Window**) o usa **Claude Sync: Resume a session**, que la abre directamente.
- Un servicio en la nube no entrega los archivos al instante: si Pull no encuentra nada, espera un minuto e inténtalo de nuevo.
- Cada dispositivo exporta a su propia carpeta (con el nombre del dispositivo, ver `claudeSessionSync.deviceName`), así que no se sobrescriben entre sí y tú eliges el origen.
- Elimina lo que exportó un dispositivo: **Claude Sync: Delete exported sessions** (pide confirmación; tus sesiones en tus dispositivos no se tocan).
- Pulsa **Claude Sync** en la barra de estado (o ejecuta **Claude Sync: Manage connection**) para cambiar el método o desconectar. Si no hay acceso al almacenamiento o no has iniciado sesión, la extensión ofrece iniciar sesión de nuevo o elegir otra vez el almacenamiento (en un dispositivo nuevo se elige una sola vez; Dropbox se encuentra incluso en un disco no estándar).
- Cambia el método cuando quieras: **Claude Sync: Choose sync method**. Para desconectar la nube: **Claude Sync: Disconnect storage** (no se borra nada del almacenamiento ni del dispositivo).

## Formas de sincronizar

| Método                        | Necesitas                                                               | Qué ocurre                                                                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub**                    | Una cuenta de GitHub                                                    | Inicio de sesión con un clic desde VS Code; se crea un repositorio privado `claude-sessions`. Si ya existe uno público con ese nombre, se rechaza.               |
| **Dropbox (directo)**         | Una cuenta de Dropbox                                                   | Inicio de sesión con un clic en el navegador, sin la aplicación de Dropbox en el equipo. Los archivos van a `Apps/Session Sync for Claude Code` en tu Dropbox.   |
| **OneDrive (directo)**        | Una cuenta de Microsoft                                                 | Inicio de sesión con un clic en el navegador, sin la aplicación de OneDrive en el equipo. Los archivos van a `Apps/Session Sync for Claude Code` en tu OneDrive. |
| **Almacenamiento en la nube** | iCloud Drive, Google Drive, MEGA, pCloud, Box, Proton Drive o Nextcloud | Eliges el servicio de una lista, se crea la carpeta «Claude Sessions» en su raíz y el cliente de la nube entrega los archivos.                                   |
| **Tu propio repositorio git** | Un repositorio privado al que tengas acceso (SSH o credential helper)   | Indica su dirección en `claudeSessionSync.repoUrl`.                                                                                                              |

## Ajustes

Todos los ajustes se aplican por equipo: defínelos en los ajustes de usuario (User settings).

| Ajuste                                | Valor por defecto | Qué hace                                                                                                                                                  |
| ------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claudeSessionSync.mode`              | vacío             | `github`, `folder` (almacenamiento en la nube) o `git`. Vacío = preguntar la primera vez.                                                                 |
| `claudeSessionSync.deviceName`        | nombre del equipo | Nombre de este dispositivo en el almacenamiento: los demás lo eligen al importar.                                                                         |
| `claudeSessionSync.projectKey`        | vacío             | El mismo valor en todos los dispositivos para un proyecto sin git remote (o con remotes distintos). Vacío = el git remote, si no el nombre de la carpeta. |
| `claudeSessionSync.repoUrl`           | vacío             | Dirección del repositorio privado para el método «git propio».                                                                                            |
| `claudeSessionSync.maxFileSizeMB`     | `90`              | Las sesiones más grandes que esto no se envían (y se te avisa).                                                                                           |
| `claudeSessionSync.maxSessionAgeDays` | `30`              | Solo se envían las sesiones modificadas en los últimos N días. `0` = sin límite.                                                                          |

## Si algo sale mal

| Qué ves                                                                                                     | Qué significa y qué hacer                                                                                             |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| «cannot reach the storage»                                                                                  | Sin internet o el servicio no responde. La extensión ya reintentó; pulsa «Try again» cuando vuelvas a estar en línea. |
| «the storage is full»                                                                                       | Libera espacio en Dropbox/OneDrive/GitHub o elige otro método.                                                        |
| «did not accept the sign-in»                                                                                | El acceso caducó o fue revocado. Pulsa «Sign in again».                                                               |
| «Another computer already pushes as …»                                                                      | Dos equipos tienen el mismo nombre de dispositivo. Renombra este (se ofrece) o confirma que es el mismo equipo.       |
| Pull no encuentra nada                                                                                      | El otro dispositivo aún no hizo Push, o usa otro método u otra clave de proyecto (ver `projectKey`).                  |
| El inicio de sesión de Dropbox/OneDrive no termina en una ventana remota (SSH, WSL, contenedor, Codespaces) | El navegador no llega a VS Code allí. Usa GitHub o tu propio repositorio git.                                         |

**Claude Sync: Disconnect storage** también elimina la copia que la extensión guarda en este equipo para sincronizar; tus propias sesiones de Claude Code nunca se tocan.

## Seguridad

- Las sesiones contienen tu código, la salida de comandos y **posiblemente secretos**. Envíalas solo a un
  almacenamiento privado: un repositorio privado o tu propia nube. La extensión te avisa antes del primer Push.
- El método GitHub pide el permiso `repo` (GitHub no tiene uno más limitado para repositorios privados). El token
  permanece dentro de VS Code y el código de la extensión es abierto.
- Con «Optimizar almacenamiento del Mac» activado en iCloud, algunas sesiones pueden no estar descargadas en este Mac.
  La extensión te indica cuántas y qué hacer.

## Limitaciones

- Se sincronizan las sesiones del proyecto actual (la primera carpeta abierta), no todos los proyectos a la vez.
- La sincronización es manual; no hay modo en segundo plano.

Código fuente e incidencias: https://github.com/htar/claude-session-sync
