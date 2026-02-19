# POTATO

Editor de notas Markdown con sincronizacion Git, wikilinks y vista previa en tiempo real.

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
sudo dpkg -i POTATO_0.17.0_amd64.deb
```

Si marca error de dependencias:

```bash
sudo apt --fix-broken install
```

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

Los cambios en HTML/CSS/JS se reflejan al instante. Los cambios en Rust recompilan automaticamente (~20s).

### Compilar para distribucion

```bash
npm run build
```

Genera los instaladores en `src-tauri/target/release/bundle/`:
- `deb/POTATO_0.17.0_amd64.deb`
- `appimage/POTATO_0.17.0_amd64.AppImage`

## Publicar una nueva version

POTATO detecta actualizaciones automaticamente al iniciar, consultando la API publica de GitHub Releases. Para que la deteccion funcione correctamente:

1. Actualizar la version en los 4 archivos:
   - `package.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`
   - `src/js/app.js` (`_appVersion`)

2. Compilar los instaladores:
   ```bash
   npm run build
   ```

3. Crear el release en GitHub con tag semver (el prefijo `v` es opcional):
   ```bash
   gh release create v0.X.0 \
     --title "POTATO v0.X.0" \
     --notes "Descripcion del release" \
     src-tauri/target/release/bundle/deb/POTATO_0.X.0_amd64.deb \
     src-tauri/target/release/bundle/appimage/POTATO_0.X.0_amd64.AppImage
   ```

> **Importante:** El release NO debe estar marcado como pre-release ni como draft. La API `/releases/latest` solo devuelve releases publicados. El `tag_name` debe ser una version mayor a la de `_appVersion` en `app.js`.

## Atajos de teclado

| Atajo | Accion |
|-------|--------|
| `Ctrl+O` | Abrir vault |
| `Ctrl+N` | Nueva nota |
| `Ctrl+S` | Guardar nota |
| `Ctrl+Shift+S` | Sincronizar con Git |
| `Ctrl+E` | Alternar Edit / Read |
| `Ctrl+Shift+E` | Vista dividida (Split view) |
| `Ctrl+B` | Mostrar / ocultar sidebar |
| `Ctrl+P` | Buscar notas y contenido |
| `Ctrl+W` | Cerrar nota |

### Claude Code CLI (para asistente IA)

Claude Code es opcional. Si lo instalas, POTATO integra un panel de chat con IA:

```bash
curl -fsSL https://claude.ai/install.sh | sh
```

## CLI

POTATO responde a argumentos de linea de comandos:

```bash
potato --version   # Muestra la version
potato --help      # Muestra la ayuda
```

## Funcionalidades

- Renderizado Markdown con soporte GFM
- Wikilinks `[[nota]]` para enlazar notas
- Sincronizacion Git interactiva (pull, seleccion de archivos, commit, push)
- Clonar repositorios GitHub directamente desde la app
- Syntax highlighting con tema Night Owl
- Frontmatter YAML renderizado como tarjeta visual
- Sidebar redimensionable con carpetas colapsables
- Busqueda instantanea por nombre y contenido
- Drag & drop para mover archivos entre carpetas
- Vista dividida (Split view): editor y preview lado a lado
- Indicadores verdes de archivos sin sincronizar (configurable)
- Indice de nota (tabla de contenido navegable por encabezados)
- Auto-guardado al dejar de escribir (configurable)
- Persistencia de sesion (recuerda vault y nota al reabrir)
- Fuente Nunito integrada
- Asistente IA integrado (Claude Code) con agentes, historial y modo vault/proyecto
- Notificacion de actualizacion desde GitHub Releases
- CLI: `--version` y `--help`

## Ajustes

Accesibles desde el menu (☰ > Ajustes):

| Opcion | Descripcion | Default |
|--------|-------------|---------|
| Indicadores de sync | Iluminar en verde archivos sin sincronizar | Activado |
| Auto-guardado | Guardar automaticamente al dejar de escribir | Activado |
| Indice de nota | Tabla de contenido con encabezados de la nota | Desactivado |

Las preferencias se guardan en `localStorage` y persisten entre sesiones.

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
│   │   ├── app.js          # Logica principal
│   │   ├── editor.js       # Editor de texto
│   │   ├── preview.js      # Vista previa Markdown
│   │   ├── sidebar.js      # Arbol de archivos
│   │   ├── claude.js       # Panel de chat con Claude Code
│   │   ├── wikilinks.js    # Parser de wikilinks
│   │   └── vendor/         # marked.js, highlight.js
│   └── index.html
├── src-tauri/              # Backend (Rust)
│   ├── src/
│   │   ├── main.rs
│   │   └── lib.rs          # Comandos Tauri
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
- Vanilla HTML/CSS/JS - Sin frameworks frontend
