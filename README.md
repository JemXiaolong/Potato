# POTATO

Editor de notas Markdown con sincronizacion Git, asistente IA integrado (Claude), servidores MCP y auto-update.

Desarrollado por **JemXiaoLong**.

## Requisitos

| Herramienta | Version minima | Instalacion |
|-------------|---------------|-------------|
| Node.js | 18+ | [nodejs.org](https://nodejs.org/) |
| Rust | 1.70+ | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Cargo | (incluido con Rust) | - |

### Dependencias del sistema (Linux)

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libgtk-3-dev \
  libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev
```

### Git (para sincronizacion)

Git debe estar instalado y configurado con SSH para sincronizar repositorios:

```bash
sudo apt install git
ssh-keygen -t ed25519
# Agrega la llave publica a GitHub: ~/.ssh/id_ed25519.pub
ssh -T git@github.com  # Verificar conexion
```

## Instalacion

### Desde .deb (usuarios)

```bash
sudo dpkg -i POTATO_0.18.5_amd64.deb
```

Si marca error de dependencias:

```bash
sudo apt --fix-broken install
```

Las siguientes actualizaciones se instalan directamente desde la app (ver [Auto-update](#auto-update)).

Para desinstalar:

```bash
sudo dpkg -r potato
```

### Desde codigo fuente (desarrollo)

```bash
git clone https://github.com/jemxiaolong/Potato.git
cd Potato
npm install
```

## Uso

### Modo desarrollo (hot-reload)

```bash
npm run dev
```

Los cambios en HTML/CSS/JS se reflejan al instante. Los cambios en Rust requieren reiniciar `npm run dev` (~20s de recompilacion).

### Compilar para distribucion

```bash
npm run build
```

Genera los instaladores en `src-tauri/target/release/bundle/`:
- `deb/POTATO_X.Y.Z_amd64.deb`
- `appimage/POTATO_X.Y.Z_amd64.AppImage`

## Funcionalidades

### Editor de notas

- Renderizado Markdown completo (GFM) con `marked.js`
- Wikilinks `[[nota]]` para enlazar notas internas (auto-crea notas inexistentes)
- Vista dividida (Split view): editor y preview lado a lado
- Syntax highlighting con tema Night Owl (`highlight.js`)
- Frontmatter YAML renderizado como tarjeta visual
- Indice de nota (tabla de contenido navegable por encabezados)
- Auto-guardado al dejar de escribir (configurable, 1.5s debounce)
- Deteccion de cambios externos (auto-recarga si el archivo cambia)
- Control de tamano de fuente (10-24px)

### Sidebar y navegacion

- Sidebar redimensionable con carpetas colapsables
- Busqueda instantanea por nombre y contenido (Ctrl+P)
- Drag & drop para mover archivos entre carpetas
- Indicadores de archivos sin sincronizar (color configurable, 7 presets)
- Persistencia de sesion (recuerda vault y nota al reabrir)

### Sincronizacion Git

- Sync interactivo paso a paso: Pull → Seleccion de archivos → Commit → Push
- Mensaje de commit automatico basado en contenido (frontmatter/encabezados)
- Clonar repositorios GitHub directamente desde la app
- Soporte SSH y HTTPS con mensajes de error claros
- Barra de progreso en tiempo real

### Asistente IA (Claude)

POTATO integra un panel lateral de chat con Claude Code. Requiere [Claude Code CLI](https://claude.ai/install.sh) instalado.

#### Modos de operacion

| Modo | Descripcion | Herramientas permitidas |
|------|-------------|------------------------|
| **Vault** | Asistencia contextual para notas | Read, Glob, Grep, WebSearch, WebFetch, Task + Write/Edit con aprobacion |
| **Proyecto** | Analisis de codigo fuente | Todas (Bash, Write, Edit, Read, Glob, Grep) |

#### Agentes y comandos custom

- Agentes: archivos `.md` en `.claude/agents/` del directorio de trabajo
- Comandos: archivos `.md` en `.claude/commands/` (invocables con `/nombre`)
- Modo **Solo agentes**: delega todo a agentes, nunca resuelve directamente
- Modo **Hibrido**: decide si resolver directamente o delegar
- Autocompletado con `@agente` y `/comando` en el input

#### MCP Servers

Conecta Claude con servicios externos (Odoo, APIs, bases de datos) via Model Context Protocol:

1. Crear archivos `.mcp.json` en tu directorio home con la configuracion del servidor
2. Abrir **Ajustes > MCP Servers > Escanear** para detectar servidores
3. Activar los servidores deseados con los toggles
4. Claude puede usar las herramientas MCP al chatear (requiere aprobacion individual)

Las herramientas MCP muestran un dialogo de aprobacion con el nombre del servidor, la operacion y los parametros antes de ejecutarse.

#### Aprobacion de herramientas

En modo Vault, las herramientas potencialmente destructivas requieren aprobacion manual:

- **Write/Edit**: muestra preview del archivo y contenido antes de aprobar
- **MCP tools**: muestra servidor, operacion y parametros
- Las herramientas aprobadas se recuerdan durante la sesion
- Las herramientas no permitidas (Bash) se rechazan automaticamente con indicador visual

#### Otras caracteristicas del chat

- Seleccion de modelo (Sonnet, Opus, Haiku)
- Historial de hasta 50 conversaciones con fechas
- Minimizar a pill flotante o maximizar a pantalla completa
- Vista de grafo para visualizar ejecucion de agentes en tiempo real
- Streaming de respuestas con indicador de actividad
- Los archivos .md creados por Claude se abren automaticamente en el editor
- Contexto de usuario configurable en Ajustes (identidad para Claude)

### Auto-update

POTATO detecta actualizaciones automaticamente al iniciar y cada 5 minutos, consultando la API de GitHub Releases. Cuando hay una nueva version:

1. Aparece un banner: "Nueva version vX.Y.Z disponible **[Actualizar]**"
2. Al hacer click en "Actualizar":
   - Descarga el `.deb` con progreso en tiempo real en el boton
   - Pide contraseña con dialogo grafico (PolicyKit/pkexec)
   - Instala con `dpkg -i`
   - Reinicia la app automaticamente

Si el usuario cancela la contraseña o hay un error de red, el boton vuelve a "Actualizar" y se muestra el error en la barra de estado.

### Tutorial post-actualizacion

Al abrir POTATO despues de una actualizacion, aparece un slideshow "Que hay de nuevo" con las novedades de la version. Se muestra una sola vez por version y se puede cerrar en cualquier momento.

### CLI

POTATO responde a argumentos de linea de comandos:

```bash
potato --version   # Muestra la version
potato --help      # Muestra la ayuda
```

## Ajustes

Accesibles desde el menu (☰ > Ajustes):

### Editor

| Opcion | Descripcion | Default |
|--------|-------------|---------|
| Indicadores de sync | Iluminar archivos sin sincronizar | Activado |
| Color de indicadores | 7 colores preset + picker personalizado | Verde (#10b981) |
| Auto-guardado | Guardar automaticamente al dejar de escribir | Activado |
| Indice de nota | Tabla de contenido con encabezados | Desactivado |

### Claude

| Opcion | Descripcion | Default |
|--------|-------------|---------|
| Directorio de agentes | Carpeta para cargar agentes custom | Usa vault |
| Solo agentes | Delegar todas las tareas a agentes | Desactivado |
| Directorio de comandos | Carpeta con comandos custom (.claude/commands) | Usa dir. agentes |
| Directorio de proyecto | Carpeta del codigo fuente para modo proyecto | No configurado |

### MCP Servers

| Opcion | Descripcion |
|--------|-------------|
| Escanear | Detecta archivos .mcp.json para conectar Claude con servicios externos |
| Toggles por servidor | Activar/desactivar servidores individuales |

### Contexto

| Opcion | Descripcion |
|--------|-------------|
| Contexto adicional | Informacion que Claude debe saber: nombre, rol, datos de usuario en servicios |

Las preferencias se guardan en `localStorage` y persisten entre sesiones.

## Atajos de teclado

| Atajo | Accion |
|-------|--------|
| `Ctrl+O` | Abrir vault |
| `Ctrl+N` | Nueva nota |
| `Ctrl+S` | Guardar nota |
| `Ctrl+W` | Cerrar nota |
| `Ctrl+Shift+S` | Sincronizar con Git |
| `Ctrl+E` | Alternar Edit / Read |
| `Ctrl+Shift+E` | Vista dividida (Split view) |
| `Ctrl+B` | Mostrar / ocultar sidebar |
| `Ctrl+P` | Buscar notas y contenido |
| `Ctrl+L` | Abrir / cerrar panel de Claude |

### En el input de Claude

| Atajo | Accion |
|-------|--------|
| `Enter` | Enviar mensaje |
| `Shift+Enter` | Nueva linea |
| `↑ / ↓` | Navegar autocompletado |
| `Tab / Enter` | Aceptar autocompletado |
| `Escape` | Cerrar autocompletado |

## Publicar una nueva version

Para que los usuarios reciban la actualizacion automatica:

1. Actualizar la version en los 4 archivos:
   - `package.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`
   - `src/js/app.js` (`_appVersion`)

2. Compilar los instaladores:
   ```bash
   npm run build
   ```

3. Crear release en GitHub:
   ```bash
   gh release create v0.X.Y \
     --title "POTATO v0.X.Y" \
     --notes "Descripcion del release" \
     src-tauri/target/release/bundle/deb/POTATO_0.X.Y_amd64.deb \
     src-tauri/target/release/bundle/appimage/POTATO_0.X.Y_amd64.AppImage
   ```

> **Importante:**
> - El release NO debe estar marcado como pre-release ni como draft. La API `/releases/latest` solo devuelve releases publicados.
> - El `tag_name` debe ser una version mayor a la de `_appVersion` en `app.js`.
> - El release debe incluir un asset `.deb` para que el auto-update funcione. Si no hay `.deb`, el boton abrira la URL del release en el navegador.

## Estructura del proyecto

```
Potato/
├── src/                    # Frontend (HTML/CSS/JS)
│   ├── css/
│   │   ├── style.css       # Tema principal
│   │   └── night-owl.css   # Tema para bloques de codigo
│   ├── fonts/              # Nunito (4 pesos)
│   ├── img/                # Logo y assets
│   ├── js/
│   │   ├── app.js          # Logica principal, settings, auto-update
│   │   ├── editor.js       # Editor de texto
│   │   ├── preview.js      # Vista previa Markdown
│   │   ├── sidebar.js      # Arbol de archivos
│   │   ├── claude.js       # Panel de Claude: chat, agentes, MCP, herramientas
│   │   ├── wikilinks.js    # Parser de wikilinks
│   │   └── vendor/         # marked.js, highlight.js
│   └── index.html
├── src-tauri/              # Backend (Rust)
│   ├── src/
│   │   ├── main.rs
│   │   └── lib.rs          # Comandos Tauri: vault, git, Claude CLI, MCP scan
│   ├── icons/              # Iconos generados
│   ├── Cargo.toml
│   └── tauri.conf.json
├── package.json
└── .gitignore
```

## Tecnologias

- [Tauri v2](https://v2.tauri.app/) - Framework de escritorio
- [marked.js](https://marked.js.org/) - Parser Markdown
- [highlight.js](https://highlightjs.org/) - Syntax highlighting
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) - Asistente IA
- Vanilla HTML/CSS/JS - Sin frameworks frontend
