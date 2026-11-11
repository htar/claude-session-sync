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
- Un servicio en la nube no entrega los archivos al instante: si Pull no encuentra nada, espera un minuto e inténtalo de nuevo.
- Cada dispositivo exporta a su propia carpeta (con el nombre del dispositivo, ver `claudeSessionSync.deviceName`), así que no se sobrescriben entre sí y tú eliges el origen.
- Elimina lo que exportó un dispositivo: **Claude Sync: Delete exported sessions** (pide confirmación; tus sesiones en tus dispositivos no se tocan).
- Cambia el método cuando quieras: **Claude Sync: Choose sync method**. Para desconectar la nube: **Claude Sync: Disconnect storage** (no se borra nada del almacenamiento ni del dispositivo).

## Formas de sincronizar

| Método                        | Necesitas                                                                                  | Qué ocurre                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub**                    | Una cuenta de GitHub                                                                       | Inicio de sesión con un clic desde VS Code; se crea un repositorio privado `claude-sessions`. Si ya existe uno público con ese nombre, se rechaza. |
| **Almacenamiento en la nube** | iCloud Drive, Dropbox, OneDrive, Google Drive, MEGA, pCloud, Box, Proton Drive o Nextcloud | Eliges el servicio de una lista, se crea la carpeta «Claude Sessions» en su raíz y el cliente de la nube entrega los archivos.                     |
| **Tu propio repositorio git** | Un repositorio privado al que tengas acceso (SSH o credential helper)                      | Indica su dirección en `claudeSessionSync.repoUrl`.                                                                                                |

## Ajustes

Todos los ajustes se aplican por equipo: defínelos en los ajustes de usuario (User settings).

| Ajuste                                | Valor por defecto | Qué hace                                                                                  |
| ------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| `claudeSessionSync.mode`              | vacío             | `github`, `folder` (almacenamiento en la nube) o `git`. Vacío = preguntar la primera vez. |
| `claudeSessionSync.deviceName`        | nombre del equipo | Nombre de este dispositivo en el almacenamiento: los demás lo eligen al importar.         |
| `claudeSessionSync.repoUrl`           | vacío             | Dirección del repositorio privado para el método «git propio».                            |
| `claudeSessionSync.maxFileSizeMB`     | `90`              | Las sesiones más grandes que esto no se envían (y se te avisa).                           |
| `claudeSessionSync.maxSessionAgeDays` | `30`              | Solo se envían las sesiones modificadas en los últimos N días. `0` = sin límite.          |

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
