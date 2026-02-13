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
- `deb/POTATO_0.1.0_amd64.deb`
- `appimage/POTATO_0.1.0_amd64.AppImage`

### Instalar .deb

```bash
sudo dpkg -i src-tauri/target/release/bundle/deb/POTATO_0.1.0_amd64.deb
```

## Atajos de teclado

| Atajo | Accion |
|-------|--------|
| `Ctrl+O` | Abrir vault |
| `Ctrl+N` | Nueva nota |
| `Ctrl+S` | Guardar nota |
| `Ctrl+Shift+S` | Sincronizar con Git |
| `Ctrl+E` | Alternar Edit / Read |
| `Ctrl+B` | Mostrar / ocultar sidebar |

## Funcionalidades

- Renderizado Markdown con soporte GFM
- Wikilinks `[[nota]]` para enlazar notas
- Sincronizacion Git interactiva (pull, seleccion de archivos, commit, push)
- Clonar repositorios GitHub directamente desde la app
- Syntax highlighting con tema Night Owl
- Frontmatter YAML renderizado como tarjeta visual
- Sidebar redimensionable con carpetas colapsables
- Fuente Nunito integrada

## Estructura del proyecto

```
Potato/
├── src/                    # Frontend (HTML/CSS/JS)
│   ├── css/
│   │   ├── style.css       # Tema principal
│   │   └── night-owl.css   # Tema para bloques de codigo
│   ├── fonts/              # Nunito (4 pesos)
│   ├── js/
│   │   ├── app.js          # Logica principal
│   │   ├── editor.js       # Editor de texto
│   │   ├── preview.js      # Vista previa Markdown
│   │   ├── sidebar.js      # Arbol de archivos
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
