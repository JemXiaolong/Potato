/**
 * App: logica principal, estado, atajos de teclado.
 */
const SYNC_COLORS = [
  { name: 'Verde',    hex: '#10b981' },
  { name: 'Violeta',  hex: '#8b5cf6' },
  { name: 'Azul',     hex: '#3b82f6' },
  { name: 'Rosa',     hex: '#ec4899' },
  { name: 'Naranja',  hex: '#f97316' },
  { name: 'Amarillo', hex: '#eab308' },
  { name: 'Cyan',     hex: '#06b6d4' },
];

const App = {
  // Estado
  state: {
    vaultPath: null,
    currentNote: null, // { path, title }
    mode: 'read',       // 'edit' | 'read'
    dirty: false,
    gitLinked: false,   // vault is a git repo with remote
    syncIndicators: true, // show unsynced file indicators
    autosave: true,       // auto-save after typing stops
    toc: false,           // show table of contents panel
  },

  _autosaveTimeout: null,
  _lastSavedContent: null,  // track content to detect external changes
  _noteHistory: [],     // stack de notas visitadas
  _noteHistoryIndex: -1, // posición actual en el stack
  _navInProgress: false, // flag para no pushear al navegar con back/forward

  // Referencia a invoke de Tauri
  invoke: null,

  async init() {
    // Tauri IPC
    if (window.__TAURI__) {
      this.invoke = window.__TAURI__.core.invoke;
    } else {
      console.warn('Tauri API no disponible, modo standalone');
      this.invoke = async () => null;
    }

    // La version real viene del binario (tauri.conf.json). Antes estaba fija
    // en este archivo y, si no se actualizaba al publicar, la app instalada
    // volvia a ofrecer la misma actualizacion indefinidamente.
    await this._loadAppVersion();

    // Inicializar componentes
    Sidebar.init(
      'file-tree',
      (path, name) => this.openNote(path, name),
      (filePath, fileName, destDir) => this._onFileDrop(filePath, fileName, destDir),
    );

    this._initErrorForwarding();

    Editor.init('editor', (content) => {
      this.state.dirty = true;
      this._refreshPreview(content);

      // Auto-save after 1.5s of inactivity
      if (this.state.autosave) {
        clearTimeout(this._autosaveTimeout);
        this._autosaveTimeout = setTimeout(() => this.saveCurrentNote(), 1500);
      }
    });

    Preview.init('preview', (target) => this.onWikilinkClick(target));

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => this._onKeyDown(e));

    // Mode toggle buttons
    document.querySelectorAll('.toggle-btn').forEach((btn) => {
      btn.addEventListener('click', () => this.setMode(btn.dataset.mode));
    });

    // Split view button
    document.getElementById('split-btn').addEventListener('click', () => this.toggleSplit());

    // Share button opens a small menu instead of acting directly, so link
    // copying and PDF export live together without adding another toolbar icon.
    this._initShareMenu();

    // File-tree sort order
    this._initSortMenu();

    // Font size controls
    document.getElementById('font-size-down').addEventListener('click', () => this._changeFontSize(-1));
    document.getElementById('font-size-up').addEventListener('click', () => this._changeFontSize(1));

    // Menu dropdown
    this._initMenu();

    // Sync button
    document.getElementById('sync-btn').addEventListener('click', () => this.gitSync());

    // Close note button
    document.getElementById('close-note-btn').addEventListener('click', () => this.closeNote());

    // Note navigation (back/forward)
    document.getElementById('note-nav-back').addEventListener('click', () => this._noteNavBack());
    document.getElementById('note-nav-forward').addEventListener('click', () => this._noteNavForward());

    // Sidebar resize
    this._initSidebarResize();

    // Listen for git progress events
    this._initProgressBar();

    // Detect external changes on window focus
    window.addEventListener('focus', () => this._onWindowFocus());

    // Claude panel
    Claude.init('claude-messages');

    // Search palette
    this._initSearch();

    // Load settings from localStorage
    this._loadSettings();

    // Load font size preference
    this._loadFontSize();

    // Restaurar sesion anterior
    await this._restoreSession();

    // POTATO_DIAG_NOTE opens a specific note at startup for load diagnostics.
    await this._openDiagNote();

    // Mostrar welcome si no hay nota abierta
    if (!this.state.currentNote) {
      this._showWelcome();
    }

    // Tour de novedades post-actualización
    this._checkWhatsNew();

    // Check for updates (non-blocking, every 5 min)
    this._checkForUpdates();
    setInterval(() => this._checkForUpdates(), 5 * 60 * 1000);
  },

  // -- Session -------------------------------------------------------------

  async _saveSession() {
    try {
      await this.invoke('save_session', {
        vaultPath: this.state.vaultPath || null,
        notePath: this.state.currentNote ? this.state.currentNote.path : null,
        noteTitle: this.state.currentNote ? this.state.currentNote.title : null,
      });
    } catch (err) {
      console.warn('No se pudo guardar sesion:', err);
    }
  },

  async _restoreSession() {
    try {
      const session = await this.invoke('load_session');
      if (!session || !session.vault_path) return false;

      // Verificar que el vault aun existe
      const entries = await this.invoke('list_vault', { path: session.vault_path });
      if (!entries) return false;

      // Restaurar vault
      await this._loadVault(session.vault_path);

      // Restaurar nota si habia una abierta
      if (session.note_path && session.note_title) {
        await this.openNote(session.note_path, session.note_title);
      }

      return true;
    } catch (err) {
      console.warn('No se pudo restaurar sesion:', err);
      return false;
    }
  },

  // -- Vault ---------------------------------------------------------------

  async openVault() {
    const path = await this.invoke('open_vault');
    if (!path) return;
    await this._loadVault(path);
  },

  async _loadVault(path) {
    this.state.vaultPath = path;

    // UI updates
    const name = path.split('/').pop();
    document.getElementById('vault-name').textContent = name.toUpperCase();
    this._setStatus(path);
    this._setTitle('');

    // Limpiar editor
    Editor.setValue('');
    Preview.clear();
    this.state.currentNote = null;

    // Check git status and changed files BEFORE rendering
    await this._checkGitStatus();
    await this._updateChangedFiles();

    // Render sidebar with unsynced indicators already set
    const entries = await this.invoke('list_vault', { path });
    Sidebar.render(entries);

    // Cargar archivos recientes
    this._loadRecentFiles(path);

    // Notificar a Claude del nuevo vault
    Claude.onVaultChanged();
    Claude.updateContext();

    // Guardar sesion
    this._saveSession();
  },

  _recentFiles: [],

  async _loadRecentFiles(path) {
    try {
      const files = await this.invoke('git_recent_files', { path, limit: 50 });
      this._recentFiles = files || [];
      this._recentAuthorFilter = '';
      this._updateFilterLabel();
      this._renderRecentFiles();
    } catch (e) {
      console.warn('No se pudieron cargar archivos recientes:', e);
    }
  },

  _cleanRecentName(name) {
    return Sidebar._cleanName(name);
  },

  _formatRecentDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const now = new Date();
    const diff = Math.floor((now - d) / 86400000);
    if (diff === 0) return 'hoy';
    if (diff === 1) return 'ayer';
    if (diff < 7) return 'hace ' + diff + 'd';
    return dateStr.slice(5); // MM-DD
  },

  _getAuthorInitials(author) {
    return author.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
  },

  _getAuthorColor(author) {
    let hash = 0;
    for (let i = 0; i < author.length; i++) hash = author.charCodeAt(i) + ((hash << 5) - hash);
    const colors = ['#c792ea', '#7fdbca', '#f78c6c', '#82aaff', '#c3e88d', '#ffcb6b', '#89ddff', '#f07178'];
    return colors[Math.abs(hash) % colors.length];
  },

  _recentAuthorFilter: '',

  _updateFilterLabel() {
    const label = document.getElementById('recent-filter-label');
    if (!label) return;
    if (this._recentAuthorFilter) {
      label.textContent = this._recentAuthorFilter + ' \u00D7';
      label.style.setProperty('--filter-color', this._getAuthorColor(this._recentAuthorFilter));
      label.classList.remove('hidden');
      label.onclick = () => {
        this._recentAuthorFilter = '';
        this._updateFilterLabel();
        this._renderRecentFiles();
      };
    } else {
      label.classList.add('hidden');
      label.onclick = null;
    }
  },

  _filterByAuthor(author) {
    if (this._recentAuthorFilter === author) {
      this._recentAuthorFilter = '';
    } else {
      this._recentAuthorFilter = author;
    }
    this._updateFilterLabel();
    this._renderRecentFiles();
  },

  _renderRecentFiles() {
    const list = document.getElementById('recent-files-list');
    const section = document.getElementById('recent-files');
    if (!list || !section) return;

    if (this._recentFiles.length === 0) {
      section.classList.add('hidden');
      return;
    }

    section.classList.remove('hidden');
    list.innerHTML = '';

    const selectedAuthor = this._recentAuthorFilter;
    const filtered = selectedAuthor
      ? this._recentFiles.filter(f => f.author === selectedAuthor)
      : this._recentFiles;

    for (const file of filtered) {
      const item = document.createElement('div');
      item.className = 'recent-item';
      item.dataset.path = file.path;
      item.title = file.name;

      const avatar = document.createElement('span');
      avatar.className = 'recent-avatar';
      avatar.textContent = this._getAuthorInitials(file.author);
      avatar.style.setProperty('--avatar-color', this._getAuthorColor(file.author));

      const info = document.createElement('div');
      info.className = 'recent-info';

      const name = document.createElement('span');
      name.className = 'recent-name';
      name.textContent = this._cleanRecentName(file.name);

      const meta = document.createElement('span');
      meta.className = 'recent-meta';
      meta.textContent = file.author + ' \u00B7 ' + this._formatRecentDate(file.date);

      info.appendChild(name);
      info.appendChild(meta);

      item.appendChild(avatar);
      item.appendChild(info);

      avatar.addEventListener('click', (e) => {
        e.stopPropagation();
        this._filterByAuthor(file.author);
      });

      item.addEventListener('click', () => {
        this.openNote(file.path, file.name);
      });

      list.appendChild(item);
    }
  },

  async refreshVault() {
    if (!this.state.vaultPath) return;
    await this._updateChangedFiles();
    const entries = await this.invoke('list_vault', { path: this.state.vaultPath });

    // refreshVault corre en cada foco de ventana: si ni el arbol ni los
    // archivos sin sincronizar cambiaron, no reconstruir el DOM del sidebar.
    const signature = JSON.stringify(entries) + '\u0000'
      + [...Sidebar._changedPaths].sort().join('\n');
    if (signature !== this._sidebarSignature) {
      this._sidebarSignature = signature;
      Sidebar.render(entries);
    }
    this._loadRecentFiles(this.state.vaultPath);
  },

  // -- Notes ---------------------------------------------------------------

  /**
   * Abre una nota. Los errores (archivo borrado, permisos, nombre invalido) se
   * muestran como toast: openNote se llama desde muchos handlers sin catch.
   */
  async openNote(path, title) {
    try {
      await this._openNote(path, title);
    } catch (e) {
      console.warn('No se pudo abrir la nota:', e);
      this._showToast('No se pudo abrir la nota: ' + e, 'error');
    }
  },

  async _openNote(path, title) {
    // Auto-guardar nota actual
    await this.saveCurrentNote();

    const content = await this.invoke('read_note', { path });

    // Push al historial de navegación (solo si no es nav back/forward)
    if (!this._navInProgress) {
      if (this._noteHistoryIndex < this._noteHistory.length - 1) {
        this._noteHistory = this._noteHistory.slice(0, this._noteHistoryIndex + 1);
      }
      this._noteHistory.push({ path, title });
      this._noteHistoryIndex = this._noteHistory.length - 1;
    }

    this.state.currentNote = { path, title };
    this.state.dirty = false;
    this._lastSavedContent = content;

    // Load without firing the change callback: a freshly opened note is not
    // dirty, and letting onChange run marked the note dirty (causing a spurious
    // full write-back 1.5s later) and rendered the preview a second time.
    // A textarea holding megabytes of text re-lays-out on every input, costing
    // ~800ms per keystroke at 6 MB. That is inside the browser's textarea, not
    // something we can optimise, so large notes open in read mode (which is
    // virtualized and fast) regardless of the remembered mode.
    if (content.length > this.LARGE_NOTE_BYTES && this.state.mode !== 'read') {
      this.state.mode = 'read';
      this._showToast('Nota grande: abierta en modo lectura', 'warn', 4000);
    }
    this._largeNoteWarned = false;

    // Decide editor visibility BEFORE loading the content. Assigning megabytes
    // into a *visible* textarea makes WebKit lay out every line (~1.6s for an
    // 80k-line note) even when read mode is about to hide it again.
    if (this.state.mode === 'read') {
      Editor.hide();
    } else {
      Editor.show();
    }

    Editor.setValue(content, { silent: true });
    this._previewStale = true;
    await this._recordNoteStat();
    this._setTitle(title);
    this._setStatus(title);

    // Mostrar controles de nota
    document.getElementById('mode-toggle').classList.remove('hidden');
    document.getElementById('close-note-btn').classList.remove('hidden');
    document.getElementById('split-btn').classList.remove('hidden');
    document.getElementById('share-btn').classList.remove('hidden');
    document.getElementById('note-nav').classList.remove('hidden');

    // Sync editor/preview visibility with current mode
    this.setMode(this.state.mode);
    Sidebar.setActive(path);
    this._updateNoteNav();

    // Update Claude context
    Claude.updateContext();
    Claude.onNoteOpened();

    // Guardar sesion
    this._saveSession();
  },

  async closeNote() {
    // Guardar antes de cerrar
    await this.saveCurrentNote();

    this.state.currentNote = null;
    this.state.dirty = false;
    this._lastSavedContent = null;

    // Ocultar controles de nota
    document.getElementById('mode-toggle').classList.add('hidden');
    document.getElementById('close-note-btn').classList.add('hidden');
    document.getElementById('split-btn').classList.add('hidden');
    document.getElementById('share-btn').classList.add('hidden');
    document.getElementById('share-menu').classList.remove('open');
    document.getElementById('note-nav').classList.add('hidden');

    // Reset split mode, TOC, and clean up
    const content = document.querySelector('.content');
    content.classList.remove('split-mode');
    content.classList.remove('toc-visible');
    document.getElementById('toc-panel').classList.add('hidden');
    this.state.mode = 'read';
    // Silent: _showWelcome below replaces the preview anyway, so there is no
    // point rendering an empty document first (which also tears down the old
    // note's DOM twice).
    Editor.setValue('', { silent: true });
    Preview.clear();
    this._previewStale = true;
    Editor.hide();
    this._setTitle('');

    // Deseleccionar en sidebar
    Sidebar.setActive(null);

    // Update Claude context
    Claude.updateContext();
    Claude.onNoteClosed();

    // Mostrar welcome
    this._showWelcome();

    // Guardar sesion (sin nota)
    this._saveSession();
  },

  async _noteNavBack() {
    if (this._noteHistoryIndex <= 0) return;
    this._noteHistoryIndex--;
    const { path, title } = this._noteHistory[this._noteHistoryIndex];
    this._navInProgress = true;
    try {
      await this.openNote(path, title);
    } finally {
      this._navInProgress = false;
    }
  },

  async _noteNavForward() {
    if (this._noteHistoryIndex >= this._noteHistory.length - 1) return;
    this._noteHistoryIndex++;
    const { path, title } = this._noteHistory[this._noteHistoryIndex];
    this._navInProgress = true;
    try {
      await this.openNote(path, title);
    } finally {
      this._navInProgress = false;
    }
  },

  _updateNoteNav() {
    const back = document.getElementById('note-nav-back');
    const forward = document.getElementById('note-nav-forward');
    back.disabled = this._noteHistoryIndex <= 0;
    forward.disabled = this._noteHistoryIndex >= this._noteHistory.length - 1;
  },

  async saveCurrentNote() {
    if (!this.state.currentNote || !this.state.dirty) return;

    const content = Editor.getValue();
    try {
      await this.invoke('save_note', {
        path: this.state.currentNote.path,
        content,
      });
    } catch (e) {
      // La nota sigue marcada como sucia para reintentar en el siguiente guardado.
      this._showToast('No se pudo guardar la nota: ' + e, 'error');
      return;
    }
    this._lastSavedContent = content;
    await this._recordNoteStat();
    this.state.dirty = false;
    this._setStatus('Guardado');
    setTimeout(() => {
      if (this.state.currentNote) {
        this._setStatus(this.state.currentNote.title);
      }
    }, 1500);

    // Update sync button indicator
    this._checkGitStatus();
  },

  createNote() {
    if (!this.state.vaultPath) return;

    const modal = document.getElementById('newnote-modal');
    const input = document.getElementById('newnote-input');
    const actionBtn = document.getElementById('newnote-btn-action');
    const cancelBtn = document.getElementById('newnote-btn-cancel');
    const closeBtn = document.getElementById('newnote-modal-close');

    modal.classList.add('open');
    input.value = '';
    input.focus();

    const close = () => modal.classList.remove('open');

    cancelBtn.onclick = close;
    closeBtn.onclick = close;

    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        actionBtn.click();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };

    actionBtn.onclick = async () => {
      const name = input.value.trim();
      if (!name) return;

      close();

      try {
        const path = await this.invoke('create_note', {
          vaultPath: this.state.vaultPath,
          name,
        });
        await this.refreshVault();
        await this.openNote(path, name);
      } catch (e) {
        this._showToast('No se pudo crear la nota: ' + e, 'error');
      }
    };
  },

  // -- Wikilinks -----------------------------------------------------------

  async onWikilinkClick(target) {
    if (!this.state.vaultPath) return;

    // Buscar la nota en el arbol ya cargado por el sidebar (antes se releia
    // el vault completo en cada clic).
    const entries = Sidebar._entries && Sidebar._entries.length
      ? Sidebar._entries
      : await this.invoke('list_vault', { path: this.state.vaultPath });
    const found = this._findEntry(entries, target);

    if (found) {
      await this.openNote(found.path, found.name);
      return;
    }

    // Crear nota si no existe
    try {
      const path = await this.invoke('create_note', {
        vaultPath: this.state.vaultPath,
        name: target,
      });
      await this.refreshVault();
      await this.openNote(path, target);
    } catch (e) {
      this._showToast('No se pudo crear la nota: ' + e, 'error');
    }
  },

  _findEntry(entries, name) {
    for (const entry of entries) {
      if (!entry.is_dir && entry.name === name) {
        return entry;
      }
      if (entry.is_dir && entry.children) {
        const found = this._findEntry(entry.children, name);
        if (found) return found;
      }
    }
    return null;
  },

  // -- Mode ----------------------------------------------------------------

  /** Past this size the textarea becomes the bottleneck, not the renderer. */
  LARGE_NOTE_BYTES: 1024 * 1024,

  _largeNoteWarned: false,

  /** True when the open note is big enough for editing to feel slow. */
  _isLargeNote() {
    return Editor.getValue().length > this.LARGE_NOTE_BYTES;
  },

  setMode(mode) {
    // Entering an editing mode on a large note is allowed, but say so first:
    // the slowness is inherent to the textarea and would otherwise look like a
    // freeze with no explanation.
    if (mode !== 'read' && this._isLargeNote() && !this._largeNoteWarned) {
      this._largeNoteWarned = true;
      const mb = (Editor.getValue().length / 1024 / 1024).toFixed(1);
      this._showToast(
        `Nota de ${mb} MB: la edicion sera lenta al escribir`,
        'warn',
        6000
      );
    }
    return this._setModeInternal(mode);
  },

  _setModeInternal(mode) {
    this.state.mode = mode;
    const content = document.querySelector('.content');
    const splitBtn = document.getElementById('split-btn');

    // Toggle Edit/Read buttons
    document.querySelectorAll('.toggle-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    // Split button state
    splitBtn.classList.toggle('active', mode === 'split');

    // Remove split mode class first
    content.classList.remove('split-mode');

    if (mode === 'edit') {
      Editor.show();
      Preview.hide();
      Editor.focus();
    } else if (mode === 'split') {
      content.classList.add('split-mode');
      this._renderPreviewIfStale();
      Editor.show();
      Preview.show();
      Editor.focus();
    } else {
      this._renderPreviewIfStale();
      Editor.hide();
      Preview.show();
    }

    // Update TOC after mode change
    this._updateToc();
  },

  // The preview is only worth rebuilding when it is on screen. In edit mode it
  // is display:none, so re-parsing on every keystroke was pure waste; instead
  // the content is marked stale and rendered when the user switches modes.
  _previewStale: true,

  _refreshPreview(content) {
    if (this.state.mode === 'edit') {
      this._previewStale = true;
      return;
    }
    Preview.update(content);
    this._previewStale = false;
    this._updateToc();
  },

  _renderPreviewIfStale(force) {
    if (!force && !this._previewStale) return;
    Preview.update(Editor.getValue());
    this._previewStale = false;
  },

  toggleMode() {
    this.setMode(this.state.mode === 'edit' ? 'read' : 'edit');
  },

  toggleSplit() {
    this.setMode(this.state.mode === 'split' ? 'read' : 'split');
  },

  toggleSidebar() {
    document.body.classList.toggle('sidebar-hidden');
  },

  _initSidebarResize() {
    Util.makeResizer('sidebar-resize', '--sidebar-w', 160, 600, 240);
  },


  // -- Keyboard shortcuts --------------------------------------------------

  _onKeyDown(e) {
    // Ctrl+Shift shortcuts
    if (e.ctrlKey && e.shiftKey && !e.altKey) {
      switch (e.key.toLowerCase()) {
        case 's':
          e.preventDefault();
          this.gitSync();
          return;
        case 'e':
          e.preventDefault();
          this.toggleSplit();
          return;
        case 'p':
          e.preventDefault();
          this.exportPdf();
          return;
      }
    }

    // Ctrl+key shortcuts
    if (e.ctrlKey && !e.shiftKey && !e.altKey) {
      switch (e.key.toLowerCase()) {
        case 'o':
          e.preventDefault();
          this.openVault();
          break;
        case 'n':
          e.preventDefault();
          this.createNote();
          break;
        case 's':
          e.preventDefault();
          this.saveCurrentNote();
          break;
        case 'e':
          e.preventDefault();
          this.toggleMode();
          break;
        case 'b':
          e.preventDefault();
          this.toggleSidebar();
          break;
        case 'w':
          e.preventDefault();
          this.closeNote();
          break;
        case 'p':
        case 'f':
          e.preventDefault();
          this._openSearch();
          break;
        case 'l':
          e.preventDefault();
          Claude.toggle();
          break;
      }
    }

    // Escape para cerrar search o nota. Si otro componente ya lo manejo (modal,
    // autocompletado, menus) o el foco esta en un campo, no cerrar la nota.
    if (e.key === 'Escape') {
      if (document.getElementById('search-overlay').classList.contains('open')) {
        this._closeSearch();
        return;
      }
      if (e.defaultPrevented
          || document.querySelector('.modal-overlay.open, #menu-dropdown.open, #sort-menu.open, #share-menu.open')
          || (e.target.closest && e.target.closest('input, select, textarea:not(#editor), [contenteditable="true"]'))) {
        return;
      }
      if (this.state.currentNote) {
        this.closeNote();
      }
    }
  },

  // -- Menu ----------------------------------------------------------------

  _initMenu() {
    const btn = document.getElementById('menu-btn');
    const dropdown = document.getElementById('menu-dropdown');

    // Abrir/cerrar; clic fuera o Escape lo cierran
    Util.bindPopup(btn, dropdown);

    // Menu actions
    document.getElementById('menu-open-vault').addEventListener('click', () => {
      dropdown.classList.remove('open');
      this.openVault();
    });

    document.getElementById('menu-new-note').addEventListener('click', () => {
      dropdown.classList.remove('open');
      this.createNote();
    });

    document.getElementById('menu-github').addEventListener('click', () => {
      dropdown.classList.remove('open');
      this._showGitHubDialog();
    });

    document.getElementById('menu-sync').addEventListener('click', () => {
      dropdown.classList.remove('open');
      this.gitSync();
    });

    document.getElementById('menu-open-folder').addEventListener('click', () => {
      dropdown.classList.remove('open');
      this._openInExplorer();
    });

    document.getElementById('menu-export-pdf').addEventListener('click', () => {
      dropdown.classList.remove('open');
      this.exportPdf();
    });

    document.getElementById('menu-settings').addEventListener('click', () => {
      dropdown.classList.remove('open');
      this._showSettings();
    });
  },

  _showGitHubDialog() {
    const modal = document.getElementById('clone-modal');
    const input = document.getElementById('clone-url-input');
    const actionBtn = document.getElementById('clone-btn-action');
    const cancelBtn = document.getElementById('clone-btn-cancel');
    const closeBtn = document.getElementById('clone-modal-close');

    modal.classList.add('open');
    input.value = '';
    input.focus();
    actionBtn.disabled = false;
    actionBtn.textContent = 'Clonar';

    const close = () => modal.classList.remove('open');

    cancelBtn.onclick = close;
    closeBtn.onclick = close;

    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        actionBtn.click();
      }
    };

    actionBtn.onclick = async () => {
      const url = input.value.trim();
      if (!url) return;

      close();

      // Ask where to clone
      this._setStatus('Selecciona carpeta destino...');
      const destFolder = await this.invoke('pick_folder');
      if (!destFolder) {
        this._setStatus('Cancelado');
        return;
      }

      // Build clone path
      const repoName = url.split('/').pop().replace('.git', '') || 'vault';
      const clonePath = destFolder + '/' + repoName;

      this._setStatus('Clonando repositorio...');
      this._showProgress();
      try {
        const result = await this.invoke('git_clone', { url, path: clonePath });
        this._hideProgress();
        this._setStatus('Clonado exitosamente');
        await this._loadVault(result);
      } catch (err) {
        this._hideProgress();
        this._showGitError(err, 'clonar');
      }
    };
  },

  // -- Git Sync (Interactive) -------------------------------------------------

  async _checkGitStatus() {
    if (!this.state.vaultPath) return;

    try {
      const status = await this.invoke('git_status', { path: this.state.vaultPath });
      const syncBtn = document.getElementById('sync-btn');
      const syncLabel = document.getElementById('sync-label');

      if (status.is_repo && status.remote) {
        this.state.gitLinked = true;
        syncBtn.classList.remove('hidden');
        syncBtn.classList.toggle('has-changes', status.has_changes);
        syncLabel.textContent = status.has_changes ? 'Sync*' : 'Sync';
      } else {
        this.state.gitLinked = false;
        syncBtn.classList.add('hidden');
      }
    } catch (err) {
      console.warn('Git status check failed:', err);
    }
  },

  // Sync state for the modal flow
  _syncState: {
    step: 'idle',       // idle, pulling, files, commit, pushing, done, error
    changedFiles: [],
    selectedFiles: [],
  },

  async gitSync() {
    if (!this.state.vaultPath || !this.state.gitLinked) return;

    // Save current note first
    await this.saveCurrentNote();

    // Reset sync state
    this._syncState = { step: 'pulling', changedFiles: [], selectedFiles: [] };

    // Open modal and start
    this._openSyncModal();
    this._syncStepPull();
  },

  _openSyncModal() {
    const modal = document.getElementById('sync-modal');
    modal.classList.add('open');

    // Close handlers
    document.getElementById('sync-modal-close').onclick = () => this._closeSyncModal();
    document.getElementById('sync-btn-cancel').onclick = () => this._closeSyncModal();

    // Select all/none
    document.getElementById('sync-select-all').onclick = () => this._syncSelectAll(true);
    document.getElementById('sync-select-none').onclick = () => this._syncSelectAll(false);

    // Reset UI
    this._syncShowStep('pull');
    document.getElementById('sync-btn-action').textContent = 'Continuar';
    document.getElementById('sync-btn-action').disabled = true;
    document.getElementById('sync-btn-cancel').textContent = 'Cancelar';
  },

  _closeSyncModal() {
    document.getElementById('sync-modal').classList.remove('open');
    this._syncState.step = 'idle';
    this._checkGitStatus();
    this.refreshVault();
  },

  _syncShowStep(step) {
    ['pull', 'files', 'commit', 'result'].forEach(s => {
      document.getElementById('sync-step-' + s).classList.toggle('hidden', s !== step);
    });
  },

  // Step 1: Pull
  async _syncStepPull() {
    this._syncShowStep('pull');
    const icon = document.querySelector('#sync-step-pull .sync-step-icon');
    const text = document.querySelector('#sync-step-pull .sync-step-text');
    const actionBtn = document.getElementById('sync-btn-action');

    icon.innerHTML = '&#8635;';
    icon.className = 'sync-step-icon spinning';
    text.textContent = 'Descargando cambios del repositorio...';
    actionBtn.disabled = true;

    try {
      const result = await this.invoke('git_pull', { path: this.state.vaultPath });

      // Pull done, show result
      icon.className = 'sync-step-icon success';
      icon.innerHTML = '&#10003;';

      if (result === 'already_up_to_date') {
        text.textContent = 'Todo al dia. No hay cambios nuevos en el repositorio.';
      } else if (result === 'no_remote_branch') {
        text.textContent = 'Sin rama remota (se creara al hacer push).';
      } else {
        text.textContent = 'Cambios descargados exitosamente.';
      }

      // Refresh vault (pull may have brought new files)
      await this.refreshVault();

      // Now check for local changes
      const files = await this.invoke('git_changed_files', { path: this.state.vaultPath });
      this._syncState.changedFiles = files;

      if (files.length === 0) {
        // No local changes, we're done
        actionBtn.textContent = 'Cerrar';
        actionBtn.disabled = false;
        actionBtn.onclick = () => this._closeSyncModal();
        text.textContent += '\nNo tienes cambios locales. Todo sincronizado.';
      } else {
        // Has changes, go to file selection
        actionBtn.textContent = 'Ver cambios (' + files.length + ')';
        actionBtn.disabled = false;
        actionBtn.onclick = () => this._syncStepFiles();
      }

    } catch (err) {
      icon.className = 'sync-step-icon error';
      icon.innerHTML = '&#10007;';

      if (err === 'auth_error') {
        text.innerHTML = 'Error de autenticacion.<br><br>Usa SSH: <code>git@github.com:user/repo.git</code>';
      } else {
        text.textContent = 'Error: ' + err;
      }

      actionBtn.textContent = 'Cerrar';
      actionBtn.disabled = false;
      actionBtn.onclick = () => this._closeSyncModal();
    }
  },

  // Step 2: File selection
  _syncStepFiles() {
    this._syncShowStep('files');
    const list = document.getElementById('sync-file-list');
    const actionBtn = document.getElementById('sync-btn-action');

    list.innerHTML = '';

    for (const file of this._syncState.changedFiles) {
      const item = document.createElement('label');
      item.className = 'sync-file-item';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.dataset.path = file.path;
      cb.addEventListener('change', () => this._syncUpdateSelection());

      const name = document.createElement('span');
      name.className = 'sync-file-name';
      name.textContent = file.path;
      name.title = file.path;

      const statusClass = file.status_code === '?' ? 'new'
        : file.status_code === 'D' ? 'deleted'
        : file.status_code === 'R' ? 'renamed'
        : 'modified';

      const badge = document.createElement('span');
      badge.className = 'sync-file-status ' + statusClass;
      badge.textContent = file.status;

      item.appendChild(cb);
      item.appendChild(name);
      item.appendChild(badge);
      list.appendChild(item);
    }

    // Update selection count
    this._syncUpdateSelection();

    actionBtn.onclick = () => this._syncStepCommit();
  },

  _syncSelectAll(checked) {
    document.querySelectorAll('#sync-file-list input[type="checkbox"]').forEach(cb => {
      cb.checked = checked;
    });
    this._syncUpdateSelection();
  },

  _syncUpdateSelection() {
    const checkboxes = document.querySelectorAll('#sync-file-list input[type="checkbox"]');
    const selected = [...checkboxes].filter(cb => cb.checked);
    const actionBtn = document.getElementById('sync-btn-action');

    this._syncState.selectedFiles = selected.map(cb => cb.dataset.path);

    if (selected.length === 0) {
      actionBtn.textContent = 'Omitir y cerrar';
      actionBtn.disabled = false;
      actionBtn.onclick = () => this._closeSyncModal();
    } else {
      actionBtn.textContent = 'Continuar (' + selected.length + ' archivos)';
      actionBtn.disabled = false;
      actionBtn.onclick = () => this._syncStepCommit();
    }
  },

  // Extract a short topic description from file content
  _extractTopic(content) {
    // Try frontmatter fields: description, topic, titulo, title
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const fm = fmMatch[1];
      for (const field of ['description', 'descripcion', 'topic', 'tema', 'title', 'titulo']) {
        const re = new RegExp('^' + field + '\\s*:\\s*(.+)', 'mi');
        const m = fm.match(re);
        if (m) {
          return m[1].trim().replace(/^["']|["']$/g, '');
        }
      }
    }

    // Try first heading
    const headingMatch = content.match(/^#{1,3}\s+(.+)/m);
    if (headingMatch) {
      return headingMatch[1].trim();
    }

    // First non-empty line (skip frontmatter)
    const body = fmMatch ? content.slice(fmMatch[0].length) : content;
    const firstLine = body.split('\n').find(l => l.trim().length > 0);
    if (firstLine) {
      return firstLine.trim().slice(0, 60);
    }

    return null;
  },

  // Generate commit message from selected files content
  async _generateCommitMessage() {
    const selected = new Set(this._syncState.selectedFiles);
    const files = this._syncState.changedFiles.filter(f => selected.has(f.path));

    const groups = { add: [], update: [], delete: [] };

    for (const f of files) {
      let topic = null;

      // Read content for non-deleted files
      if (f.status_code !== 'D') {
        try {
          const absPath = this.state.vaultPath + '/' + f.path;
          const content = await this.invoke('read_note', { path: absPath });
          if (content) topic = this._extractTopic(content);
        } catch (_) { /* ignore */ }
      }

      // Fallback to clean filename
      if (!topic) {
        topic = f.path.split('/').pop().replace(/\.md$/i, '');
      }

      // Lowercase first char for natural reading
      topic = topic.charAt(0).toLowerCase() + topic.slice(1);

      if (f.status_code === '?' || f.status_code === 'A') {
        groups.add.push(topic);
      } else if (f.status_code === 'D') {
        groups.delete.push(topic);
      } else {
        groups.update.push(topic);
      }
    }

    const parts = [];
    if (groups.add.length) parts.push('add ' + groups.add.join(', '));
    if (groups.update.length) parts.push('update ' + groups.update.join(', '));
    if (groups.delete.length) parts.push('remove ' + groups.delete.join(', '));

    const msg = parts.join('; ') || 'vault sync';
    return '[DOC] ' + msg;
  },

  // Step 3: Commit message
  async _syncStepCommit() {
    if (this._syncState.selectedFiles.length === 0) {
      this._closeSyncModal();
      return;
    }

    this._syncShowStep('commit');
    const input = document.getElementById('sync-commit-msg');
    const actionBtn = document.getElementById('sync-btn-action');

    // Auto-generate commit message from file contents
    input.value = 'Generando mensaje...';
    input.disabled = true;
    const msg = await this._generateCommitMessage();
    input.value = msg;
    input.disabled = false;
    input.placeholder = 'Describe tus cambios...';
    input.focus();
    input.select();

    actionBtn.textContent = 'Subir cambios';
    actionBtn.disabled = false;
    actionBtn.onclick = () => this._syncStepPush();

    // Allow Enter to submit
    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._syncStepPush();
      }
    };
  },

  // Step 4: Stage, commit, push
  async _syncStepPush() {
    const input = document.getElementById('sync-commit-msg');
    const message = input.value.trim() || '[DOC] vault sync';

    this._syncShowStep('result');
    const icon = document.getElementById('sync-result-icon');
    const text = document.getElementById('sync-result-text');
    const actionBtn = document.getElementById('sync-btn-action');
    const cancelBtn = document.getElementById('sync-btn-cancel');

    icon.className = 'sync-step-icon spinning';
    icon.innerHTML = '&#8635;';
    text.textContent = 'Subiendo cambios...';
    actionBtn.disabled = true;
    cancelBtn.style.display = 'none';

    try {
      // Stage selected files
      text.textContent = 'Agregando archivos al stage...';
      await this.invoke('git_stage_files', {
        path: this.state.vaultPath,
        files: this._syncState.selectedFiles,
      });

      // Commit
      text.textContent = 'Creando commit...';
      await this.invoke('git_commit', {
        path: this.state.vaultPath,
        message,
      });

      // Push
      text.textContent = 'Subiendo al repositorio...';
      await this.invoke('git_push', { path: this.state.vaultPath });

      // Final pull to stay in sync
      text.textContent = 'Sincronizacion final...';
      await this.invoke('git_pull', { path: this.state.vaultPath });
      await this.refreshVault();

      // Done!
      icon.className = 'sync-step-icon success';
      icon.innerHTML = '&#10003;';
      text.textContent = 'Cambios subidos exitosamente.';

      actionBtn.textContent = 'Cerrar';
      actionBtn.disabled = false;
      actionBtn.onclick = () => this._closeSyncModal();

    } catch (err) {
      icon.className = 'sync-step-icon error';
      icon.innerHTML = '&#10007;';

      if (err === 'auth_error') {
        text.innerHTML = 'Error de autenticacion.<br>Configura SSH keys para tu repositorio.';
      } else {
        text.textContent = 'Error: ' + err;
      }

      actionBtn.textContent = 'Cerrar';
      actionBtn.disabled = false;
      actionBtn.onclick = () => this._closeSyncModal();
    }

    cancelBtn.style.display = '';
  },

  // -- Move file (drag & drop) ------------------------------------------------

  _onFileDrop(filePath, fileName, destDir) {
    // destDir is null when dropping on vault root
    const destPath = destDir || this.state.vaultPath;
    if (!destPath) return;

    const destName = destDir ? destDir.split('/').pop() : 'raiz del vault';

    const modal = document.getElementById('move-modal');
    const closeBtn = document.getElementById('move-modal-close');
    const cancelBtn = document.getElementById('move-btn-cancel');
    const actionBtn = document.getElementById('move-btn-action');

    // Display file and folder names
    document.getElementById('move-file-name').textContent = fileName;
    document.getElementById('move-dest-name').textContent = destName;

    modal.classList.add('open');

    const close = () => modal.classList.remove('open');

    closeBtn.onclick = close;
    cancelBtn.onclick = close;

    actionBtn.onclick = async () => {
      close();

      try {
        const newPath = await this.invoke('move_file', {
          from: filePath,
          toDir: destPath,
        });

        // If the moved file is the currently open note, update its path
        if (this.state.currentNote && this.state.currentNote.path === filePath) {
          this.state.currentNote.path = newPath;
          this._saveSession();
        }

        // Refresh the vault tree
        await this.refreshVault();

        // Re-select the moved file if it was active
        if (this.state.currentNote && this.state.currentNote.path === newPath) {
          Sidebar.setActive(newPath);
        }

        this._setStatus('Archivo movido');
        setTimeout(() => {
          if (this.state.currentNote) {
            this._setStatus(this.state.currentNote.title);
          }
        }, 1500);
      } catch (err) {
        this._setStatus('Error al mover');
        alert('Error al mover archivo:\n\n' + err);
      }
    };
  },

  _openInExplorer() {
    if (!this.state.vaultPath) {
      alert('Primero abre un vault (Ctrl+O)');
      return;
    }
    if (this.invoke) {
      this.invoke('open_in_explorer', { path: this.state.vaultPath });
    }
  },

  _applySyncColor(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    // Variante clara: blend 30% hacia blanco
    const lr = Math.round(r + (255 - r) * 0.3);
    const lg = Math.round(g + (255 - g) * 0.3);
    const lb = Math.round(b + (255 - b) * 0.3);
    const light = `#${lr.toString(16).padStart(2,'0')}${lg.toString(16).padStart(2,'0')}${lb.toString(16).padStart(2,'0')}`;
    const bg = `rgba(${r}, ${g}, ${b}, 0.12)`;
    const s = document.documentElement.style;
    s.setProperty('--sync-color', hex);
    s.setProperty('--sync-color-light', light);
    s.setProperty('--sync-color-bg', bg);
  },

  _loadSettings() {
    // Sync indicators
    const storedSync = localStorage.getItem('potato-sync-indicators');
    this.state.syncIndicators = storedSync === null ? true : storedSync === 'true';

    const syncToggle = document.getElementById('setting-sync-indicators');
    const syncColorRow = document.getElementById('setting-sync-color-row');
    if (syncToggle) {
      syncToggle.checked = this.state.syncIndicators;
      syncToggle.addEventListener('change', () => {
        this.state.syncIndicators = syncToggle.checked;
        localStorage.setItem('potato-sync-indicators', syncToggle.checked);
        if (syncColorRow) syncColorRow.style.display = syncToggle.checked ? '' : 'none';
        this.refreshVault();
      });
    }

    // Sync color
    const savedColor = localStorage.getItem('potato-sync-color') || '#10b981';
    this._applySyncColor(savedColor);

    if (syncColorRow) {
      syncColorRow.style.display = this.state.syncIndicators ? '' : 'none';
      const container = document.getElementById('sync-color-swatches');
      if (container) {
        container.innerHTML = '';
        SYNC_COLORS.forEach(c => {
          const sw = document.createElement('div');
          sw.className = 'sync-color-swatch' + (c.hex === savedColor ? ' active' : '');
          sw.style.background = c.hex;
          sw.title = c.name;
          sw.addEventListener('click', () => {
            container.querySelectorAll('.sync-color-swatch, .sync-color-custom').forEach(el => el.classList.remove('active'));
            sw.classList.add('active');
            this._applySyncColor(c.hex);
            localStorage.setItem('potato-sync-color', c.hex);
          });
          container.appendChild(sw);
        });
        // Custom color picker
        const isCustom = !SYNC_COLORS.some(c => c.hex === savedColor);
        const custom = document.createElement('div');
        custom.className = 'sync-color-custom' + (isCustom ? ' active' : '');
        custom.title = 'Color personalizado';
        const dot = document.createElement('div');
        dot.className = 'sync-color-custom-dot';
        if (isCustom) dot.style.background = savedColor;
        custom.appendChild(dot);
        const input = document.createElement('input');
        input.type = 'color';
        input.className = 'sync-color-custom-input';
        input.value = savedColor;
        input.addEventListener('input', (e) => {
          const hex = e.target.value;
          container.querySelectorAll('.sync-color-swatch, .sync-color-custom').forEach(el => el.classList.remove('active'));
          custom.classList.add('active');
          dot.style.background = hex;
          this._applySyncColor(hex);
          localStorage.setItem('potato-sync-color', hex);
        });
        custom.appendChild(input);
        container.appendChild(custom);
      }
    }

    // Auto-save
    const storedAutosave = localStorage.getItem('potato-autosave');
    this.state.autosave = storedAutosave === null ? true : storedAutosave === 'true';

    const autosaveToggle = document.getElementById('setting-autosave');
    if (autosaveToggle) {
      autosaveToggle.checked = this.state.autosave;
      autosaveToggle.addEventListener('change', () => {
        this.state.autosave = autosaveToggle.checked;
        localStorage.setItem('potato-autosave', autosaveToggle.checked);
      });
    }

    // TOC (table of contents)
    const storedToc = localStorage.getItem('potato-toc');
    this.state.toc = storedToc === null ? false : storedToc === 'true';

    const tocToggle = document.getElementById('setting-toc');
    if (tocToggle) {
      tocToggle.checked = this.state.toc;
      tocToggle.addEventListener('change', () => {
        this.state.toc = tocToggle.checked;
        localStorage.setItem('potato-toc', tocToggle.checked);
        this._updateToc();
      });
    }
  },

  _showSettings() {
    const modal = document.getElementById('settings-modal');
    const closeBtn = document.getElementById('settings-modal-close');
    const actionBtn = document.getElementById('settings-btn-close');

    // Sync toggle states with current values
    const syncToggle = document.getElementById('setting-sync-indicators');
    if (syncToggle) syncToggle.checked = this.state.syncIndicators;
    const syncColorRow = document.getElementById('setting-sync-color-row');
    if (syncColorRow) syncColorRow.style.display = this.state.syncIndicators ? '' : 'none';
    const autosaveToggle = document.getElementById('setting-autosave');
    if (autosaveToggle) autosaveToggle.checked = this.state.autosave;
    const tocToggle = document.getElementById('setting-toc');
    if (tocToggle) tocToggle.checked = this.state.toc;

    // Claude settings sync
    Claude._updateWorkdirDisplay();
    Claude._updateProjectDirDisplay();
    Claude._updateCommandsDirDisplay();
    const agentsOnlyToggle = document.getElementById('setting-claude-agents-only');
    if (agentsOnlyToggle) agentsOnlyToggle.checked = Claude.state.agentsOnly;

    // MCP servers: renderizar lista guardada y actualizar botón
    Claude._renderMcpList();
    const mcpBtn = document.getElementById('setting-mcp-scan-btn');
    if (mcpBtn && Claude.state.mcpServers.length > 0) {
      mcpBtn.textContent = `Escanear (${Claude.state.mcpServers.length})`;
    }

    modal.classList.add('open');

    const close = () => modal.classList.remove('open');
    closeBtn.onclick = close;
    actionBtn.onclick = close;
  },

  _showGitError(err, action) {
    const msg = typeof err === 'string' ? err : String(err);
    const isAuth = msg.includes('Authentication') ||
                   msg.includes('Permission denied') ||
                   msg.includes('autenticacion') ||
                   msg.includes('terminal prompts disabled') ||
                   msg.includes('could not read Username');

    if (isAuth) {
      this._setStatus('Auth error');
      alert(
        'No se pudo autenticar con GitHub.\n\n' +
        'Usa URL SSH en vez de HTTPS:\n' +
        '  git@github.com:usuario/repo.git\n\n' +
        'Y asegurate de tener SSH configurado:\n' +
        '  1. ssh-keygen -t ed25519\n' +
        '  2. Agrega la llave a GitHub\n' +
        '  3. ssh-add ~/.ssh/id_ed25519\n' +
        '  4. Prueba: ssh -T git@github.com'
      );
    } else {
      this._setStatus('Error ' + action);
      alert('Error al ' + action + ':\n\n' + msg);
    }
  },

  // -- Progress bar --------------------------------------------------------

  _initProgressBar() {
    if (window.__TAURI__ && window.__TAURI__.event) {
      window.__TAURI__.event.listen('git-progress', (event) => {
        const { phase, percent } = event.payload;
        this._updateProgress(phase, percent);
      });

      window.__TAURI__.event.listen('update-progress', (event) => {
        const { percent } = event.payload;
        const btn = document.getElementById('update-link');
        if (btn && btn.disabled) {
          btn.textContent = 'Descargando ' + percent + '%...';
        }
      });
    }
  },

  _showProgress() {
    document.getElementById('progress-bar').classList.add('active');
    document.getElementById('progress-fill').style.width = '0%';
    document.getElementById('progress-text').textContent = 'Preparando...';
  },

  _updateProgress(phase, percent) {
    const bar = document.getElementById('progress-bar');
    const fill = document.getElementById('progress-fill');
    const text = document.getElementById('progress-text');

    bar.classList.add('active');
    fill.style.width = percent + '%';
    text.textContent = phase + ' ' + percent + '%';
  },

  _hideProgress() {
    const bar = document.getElementById('progress-bar');
    const fill = document.getElementById('progress-fill');
    fill.style.width = '100%';
    setTimeout(() => {
      bar.classList.remove('active');
      fill.style.width = '0%';
    }, 800);
  },

  // -- Table of contents (TOC) -----------------------------------------------

  _updateToc() {
    const panel = document.getElementById('toc-panel');
    const list = document.getElementById('toc-list');
    const content = document.querySelector('.content');

    if (!this.state.toc || !this.state.currentNote || this.state.mode === 'edit') {
      panel.classList.add('hidden');
      content.classList.remove('toc-visible');
      return;
    }

    const headings = Preview.getHeadings();
    if (headings.length === 0) {
      panel.classList.add('hidden');
      content.classList.remove('toc-visible');
      return;
    }

    // One delegated listener instead of one closure per heading: a large note
    // can have thousands of entries and the list is rebuilt on every render.
    list.innerHTML = '';
    const fragment = document.createDocumentFragment();
    for (const h of headings) {
      const item = document.createElement('div');
      item.className = 'toc-item h' + h.level;
      item.textContent = h.text;
      item.dataset.headingId = h.id;
      fragment.appendChild(item);
    }
    list.appendChild(fragment);

    if (!this._tocClickBound) {
      this._tocClickBound = true;
      list.addEventListener('click', (e) => {
        const item = e.target.closest('.toc-item');
        if (!item) return;
        // The target heading may live in a section that is still a placeholder,
        // so ask the preview to hydrate it before scrolling.
        const target = Preview.revealHeading(item.dataset.headingId);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    panel.classList.remove('hidden');
    content.classList.add('toc-visible');
  },

  // -- External change detection -----------------------------------------------

  _focusCooldown: false,
  _lastSavedStat: null,

  /** Remember the on-disk fingerprint of the current note. */
  async _recordNoteStat() {
    if (!this.state.currentNote) {
      this._lastSavedStat = null;
      return;
    }
    try {
      this._lastSavedStat = await this.invoke('note_stat', {
        path: this.state.currentNote.path,
      });
    } catch (err) {
      this._lastSavedStat = null;
    }
  },

  async _onWindowFocus() {
    if (!this.state.vaultPath || this._focusCooldown) return;

    // Cooldown to avoid rapid repeated checks
    this._focusCooldown = true;
    setTimeout(() => { this._focusCooldown = false; }, 1000);

    // Refresh sidebar (picks up new/deleted/renamed files)
    await this.refreshVault();

    // Check if current note was changed externally
    if (!this.state.currentNote) return;

    try {
      // Probe size/mtime first. Reading the whole note back on every focus was
      // the single most expensive idle operation on large files.
      const stat = await this.invoke('note_stat', { path: this.state.currentNote.path });
      if (stat && this._lastSavedStat
          && stat.size === this._lastSavedStat.size
          && stat.mtime === this._lastSavedStat.mtime) {
        return;
      }

      // read_note rechaza (no devuelve null) si el archivo ya no existe.
      const diskContent = await this.invoke('read_note', { path: this.state.currentNote.path })
        .catch(() => null);

      if (diskContent === null) {
        // File was deleted externally
        this._setStatus('Nota eliminada externamente');
        this.state.dirty = false;
        this._lastSavedContent = null;
        await this.closeNote();
        return;
      }

      // Compare with last saved version (not editor, to detect external edits)
      if (this._lastSavedContent !== null && diskContent !== this._lastSavedContent) {
        if (!this.state.dirty) {
          // No local changes: reload silently. Silent setValue plus one
          // explicit render, instead of setValue's callback rendering once and
          // Preview.update rendering the same content again.
          Editor.setValue(diskContent, { silent: true });
          this._lastSavedContent = diskContent;
          await this._recordNoteStat();
          this._previewStale = true;
          this._renderPreviewIfStale();
          this._updateToc();
          this._setStatus('Nota recargada');
          setTimeout(() => {
            if (this.state.currentNote) this._setStatus(this.state.currentNote.title);
          }, 2000);
        } else {
          // Has local unsaved changes: warn the user
          this._setStatus('Cambio externo detectado (tienes cambios sin guardar)');
        }
      }
    } catch (err) {
      // File probably deleted
      this._setStatus('Nota no encontrada');
      this.state.dirty = false;
      this._lastSavedContent = null;
      await this.closeNote();
    }
  },

  // -- Font size ---------------------------------------------------------------

  _fontSize: 14,

  _loadFontSize() {
    const stored = localStorage.getItem('potato-font-size');
    this._fontSize = stored ? parseInt(stored, 10) : 14;
    this._applyFontSize();
  },

  _changeFontSize(delta) {
    const newSize = Math.max(10, Math.min(24, this._fontSize + delta));
    if (newSize === this._fontSize) return;
    this._fontSize = newSize;
    localStorage.setItem('potato-font-size', newSize);
    this._applyFontSize();
  },

  _applyFontSize() {
    document.documentElement.style.setProperty('--font-size', this._fontSize + 'px');
    document.getElementById('font-size-label').textContent = this._fontSize;
  },

  // -- Share -----------------------------------------------------------------

  /**
   * Copy a shareable link to the current note.
   *
   * The vault is a git repository, so the note already has a canonical web
   * address on the hosting provider. When the vault has no usable remote we
   * fall back to copying the vault-relative path plus its wikilink.
   */
  async shareNote() {
    if (!this.state.currentNote) return;

    // Flush pending edits so the link points at what the user sees.
    await this.saveCurrentNote();

    let link;
    try {
      link = await this.invoke('git_share_link', {
        vaultPath: this.state.vaultPath,
        notePath: this.state.currentNote.path,
      });
    } catch (err) {
      console.warn('Could not build share link:', err);
      this._setStatus('No se pudo generar el enlace');
      return;
    }

    if (!link) return;

    let payload;
    let message;
    let variant = 'success';

    if (link.url) {
      payload = link.url;
      if (link.sync_state === 'uncommitted') {
        message = 'Enlace copiado — la nota tiene cambios sin sincronizar (Ctrl+Shift+S)';
        variant = 'warn';
      } else if (link.sync_state === 'unpushed') {
        message = 'Enlace copiado — hay commits sin subir (Ctrl+Shift+S)';
        variant = 'warn';
      } else if (link.sync_state === 'unknown') {
        message = 'Enlace copiado — sin rama remota configurada, verifica que exista';
        variant = 'warn';
      } else {
        message = 'Enlace guardado en el portapapeles';
      }
    } else {
      // No remote (or an unsupported host): share what still identifies the
      // note inside a shared vault.
      const title = this.state.currentNote.title.replace(/\.md$/i, '');
      payload = `${link.relative_path}\n[[${title}]]`;
      message =
        link.provider === 'unsupported'
          ? 'Ruta copiada — el remoto no es GitHub/GitLab'
          : 'Ruta copiada — el vault no tiene remoto configurado';
      variant = 'warn';
    }

    const copied = await this._copyToClipboard(payload);
    if (!copied) {
      this._showToast('No se pudo copiar al portapapeles', 'error');
      this._setStatus('No se pudo copiar al portapapeles');
      return;
    }

    this._showToast(message, variant);
    this._setStatus(message);

    const btn = document.getElementById('share-btn');
    btn.classList.add('copied');
    clearTimeout(this._shareFeedbackTimeout);
    this._shareFeedbackTimeout = setTimeout(() => {
      btn.classList.remove('copied');
      if (this.state.currentNote) this._setStatus(this.state.currentNote.title);
    }, 2500);
  },

  // -- File tree sort order --------------------------------------------------

  _initSortMenu() {
    const btn = document.getElementById('sort-btn');
    const menu = document.getElementById('sort-menu');

    // Restore the saved order before the first render.
    const stored = localStorage.getItem('potato-sort-mode');
    const valid = ['name-asc', 'name-desc', 'mtime-desc', 'mtime-asc'];
    const mode = valid.includes(stored) ? stored : 'name-asc';
    Sidebar.setSortMode(mode);
    this._markSortSelection(mode);

    Util.bindPopup(btn, menu);

    menu.querySelectorAll('.sort-menu-item').forEach((item) => {
      item.addEventListener('click', () => {
        menu.classList.remove('open');
        this.setSortMode(item.dataset.sort);
      });
    });
  },

  setSortMode(mode) {
    if (mode === Sidebar.getSortMode()) return;

    Sidebar.setSortMode(mode);
    localStorage.setItem('potato-sort-mode', mode);
    this._markSortSelection(mode);
    // Re-sort the tree already in memory; no need to re-read the vault.
    Sidebar.rerender();
    if (this.state.currentNote) Sidebar.setActive(this.state.currentNote.path);
  },

  _markSortSelection(mode) {
    document.querySelectorAll('#sort-menu .sort-menu-item').forEach((item) => {
      item.classList.toggle('selected', item.dataset.sort === mode);
    });
    // Highlight the button when the order is not the default.
    document.getElementById('sort-btn').classList.toggle('active', mode !== 'name-asc');
  },

  // -- Diagnostics -----------------------------------------------------------

  /**
   * Send frontend errors to the Rust side so they appear in the terminal.
   *
   * WebKitGTK keeps console output and uncaught exceptions inside the inspector,
   * so a thrown error during note loading looked like "nothing happened".
   */
  _initErrorForwarding() {
    const send = (level, message) => {
      try {
        this.invoke('log_frontend', { level, message: String(message).slice(0, 4000) });
      } catch (e) {
        /* logging must never itself break the app */
      }
    };

    window.addEventListener('error', (e) => {
      const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : '';
      const stack = e.error && e.error.stack ? '\n' + e.error.stack : '';
      send('error', (e.message || 'error') + where + stack);
    });

    window.addEventListener('unhandledrejection', (e) => {
      const reason = e.reason;
      const detail = reason && reason.stack ? reason.stack : String(reason);
      send('rejection', detail);
    });

    this.log = send;
  },

  /** Log a message to the terminal; no-op safe before init. */
  log(level, message) {
    /* replaced by _initErrorForwarding */
  },

  async _openDiagNote() {
    let target = null;
    try {
      target = await this.invoke('diag_note_path');
    } catch (err) {
      return;
    }
    if (!target) return;

    this.log('diag', 'opening ' + target);
    const started = performance.now();
    try {
      const title = target.split('/').pop();
      await this.openNote(target, title);
      this.log('diag', `openNote completed in ${(performance.now() - started).toFixed(0)}ms`);
    } catch (err) {
      this.log('diag', 'openNote threw: ' + (err && err.stack ? err.stack : err));
    }
  },

  // -- Share menu ------------------------------------------------------------

  _initShareMenu() {
    const btn = document.getElementById('share-btn');
    const menu = document.getElementById('share-menu');

    Util.bindPopup(btn, menu);

    document.getElementById('share-menu-link').addEventListener('click', () => {
      menu.classList.remove('open');
      this.shareNote();
    });

    document.getElementById('share-menu-pdf').addEventListener('click', () => {
      menu.classList.remove('open');
      this.exportPdf();
    });
  },

  // -- PDF export ------------------------------------------------------------

  _exporting: false,

  /**
   * Export the open note to PDF.
   *
   * The webview's print engine lays out whatever is in the DOM, so every
   * section has to be hydrated first (lazy rendering is exactly wrong here) and
   * the print-only header has to be injected before the job starts.
   */
  async exportPdf() {
    if (!this.state.currentNote) {
      this._showToast('Abre una nota antes de exportar', 'warn');
      return;
    }
    if (this._exporting) return;
    this._exporting = true;

    const previousMode = this.state.mode;
    const title = this.state.currentNote.title.replace(/\.md$/i, '');

    try {
      const content = Editor.getValue();
      if (content.length > 2 * 1024 * 1024) {
        this._showToast('Nota grande: preparando el PDF, puede tardar…', 'warn', 8000);
      } else {
        this._showToast('Preparando el PDF…', 'success', 8000);
      }

      // Let the toast paint before the render blocks the thread.
      await this._nextFrame();

      // Print needs the complete document, not just the visible sections.
      Preview.update(content, { full: true });
      await Preview.renderAll();
      this._previewStale = true;

      this._buildPrintHeader(title);

      const targetPath = await this.invoke('pick_pdf_path', {
        defaultName: title + '.pdf',
      });
      if (!targetPath) {
        this._setStatus(this.state.currentNote.title);
        return;
      }

      const savedPath = await this.invoke('export_pdf', { outputPath: targetPath });
      const fileName = String(savedPath).split('/').pop();
      this._showToast('PDF guardado: ' + fileName, 'success', 5000);
    } catch (err) {
      console.warn('PDF export failed:', err);
      this._showToast('No se pudo exportar el PDF: ' + err, 'error', 6000);
    } finally {
      this._removePrintHeader();
      this._exporting = false;
      // Rebuild the normal, lazily rendered preview so the app is not left
      // holding the fully expanded DOM.
      this.setMode(previousMode);
      this._renderPreviewIfStale(true);
      this._updateToc();
    }
  },

  _nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  },

  _buildPrintHeader(title) {
    this._removePrintHeader();

    const header = document.createElement('div');
    header.className = 'print-header print-only';
    header.id = 'print-header';

    const heading = document.createElement('div');
    heading.className = 'print-header-title';
    heading.textContent = title;
    header.appendChild(heading);

    const meta = document.createElement('div');
    meta.className = 'print-header-meta';

    // Vault-relative path locates the note without leaking the whole home dir.
    let relative = this.state.currentNote.path;
    if (this.state.vaultPath && relative.startsWith(this.state.vaultPath)) {
      relative = relative.slice(this.state.vaultPath.length).replace(/^\//, '');
    }

    const pathSpan = document.createElement('span');
    pathSpan.textContent = relative;
    meta.appendChild(pathSpan);

    const dateSpan = document.createElement('span');
    dateSpan.textContent = new Date().toLocaleDateString('es-MX', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    meta.appendChild(dateSpan);

    header.appendChild(meta);

    const preview = document.getElementById('preview');
    preview.insertBefore(header, preview.firstChild);
  },

  _removePrintHeader() {
    const existing = document.getElementById('print-header');
    if (existing) existing.remove();
  },

  // -- Toasts ----------------------------------------------------------------

  _toastIcons: {
    success:
      '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M5.2 8.2l2 2 3.6-4"/></svg>',
    warn:
      '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.8l6.2 11.4H1.8z"/><line x1="8" y1="6" x2="8" y2="9.4"/><line x1="8" y1="11.4" x2="8" y2="11.5"/></svg>',
    error:
      '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><line x1="6" y1="6" x2="10" y2="10"/><line x1="10" y1="6" x2="6" y2="10"/></svg>',
  },

  /**
   * Show a transient toast above the status bar.
   * Variants: 'success' (default), 'warn', 'error'.
   */
  _showToast(message, variant = 'success', duration = null) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const kind = this._toastIcons[variant] ? variant : 'success';
    // Warnings carry an instruction, so they need longer on screen.
    const ms = duration !== null ? duration : kind === 'success' ? 2600 : 4500;

    const toast = document.createElement('div');
    toast.className = 'toast ' + kind;

    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.innerHTML = this._toastIcons[kind];

    // textContent: the message can carry note titles / paths.
    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message;

    toast.appendChild(icon);
    toast.appendChild(text);
    container.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('visible'));

    const remove = () => {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 200);
    };
    setTimeout(remove, ms);
  },

  async _copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) {
      console.warn('Clipboard API failed, falling back:', err);
    }

    // WebKitGTK can reject the async Clipboard API outside a user gesture.
    try {
      const helper = document.createElement('textarea');
      helper.value = text;
      helper.setAttribute('readonly', '');
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(helper);
      return ok;
    } catch (err) {
      console.warn('Clipboard fallback failed:', err);
      return false;
    }
  },

  // -- Changed files (unsynced indicators) -----------------------------------

  async _updateChangedFiles() {
    if (!this.state.vaultPath || !this.state.gitLinked || !this.state.syncIndicators) {
      Sidebar.setChangedFiles([]);
      return;
    }
    try {
      const files = await this.invoke('git_changed_files', { path: this.state.vaultPath });
      const absolutePaths = files.map(f => this.state.vaultPath + '/' + f.path);
      Sidebar.setChangedFiles(absolutePaths);
    } catch (err) {
      console.warn('Could not get changed files:', err);
      Sidebar.setChangedFiles([]);
    }
  },

  // -- Helpers -------------------------------------------------------------

  _setTitle(text) {
    document.getElementById('note-title').textContent = text;
  },

  _setStatus(text) {
    document.getElementById('status-text').textContent = text;
  },

  // -- Search ----------------------------------------------------------------

  _searchTimeout: null,
  _searchIndex: -1,

  _initSearch() {
    const overlay = document.getElementById('search-overlay');
    const input = document.getElementById('search-input');
    const toolbarInput = document.getElementById('toolbar-search-input');

    // Close on overlay click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this._closeSearch();
    });

    // Search on input (palette)
    input.addEventListener('input', () => {
      clearTimeout(this._searchTimeout);
      this._searchTimeout = setTimeout(() => this._doSearch(), 200);
    });

    // Keyboard navigation (palette)
    input.addEventListener('keydown', (e) => {
      const items = document.querySelectorAll('.search-result');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this._searchIndex = Math.min(this._searchIndex + 1, items.length - 1);
        this._highlightSearchResult(items);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this._searchIndex = Math.max(this._searchIndex - 1, 0);
        this._highlightSearchResult(items);
      } else if (e.key === 'Enter' && this._searchIndex >= 0 && items[this._searchIndex]) {
        e.preventDefault();
        items[this._searchIndex].click();
      }
    });

    // Toolbar search: open palette on input
    toolbarInput.addEventListener('input', () => {
      const query = toolbarInput.value;
      if (!this.state.vaultPath) return;
      if (!overlay.classList.contains('open')) {
        this._openSearch(query);
      } else {
        input.value = query;
        clearTimeout(this._searchTimeout);
        this._searchTimeout = setTimeout(() => this._doSearch(), 200);
      }
    });

    // Toolbar search: open palette on focus click
    toolbarInput.addEventListener('focus', () => {
      if (toolbarInput.value.length >= 2) {
        this._openSearch(toolbarInput.value);
      }
    });

    // Toolbar search: Escape to blur
    toolbarInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        toolbarInput.blur();
        toolbarInput.value = '';
      }
      if (e.key === 'Enter' && toolbarInput.value.trim().length >= 2) {
        this._openSearch(toolbarInput.value);
      }
    });
  },

  _openSearch(initialQuery) {
    if (!this.state.vaultPath) return;
    const overlay = document.getElementById('search-overlay');
    const input = document.getElementById('search-input');
    overlay.classList.add('open');
    input.value = initialQuery || '';
    input.focus();
    this._searchIndex = -1;

    if (initialQuery && initialQuery.length >= 2) {
      this._doSearch();
    } else {
      document.getElementById('search-results').innerHTML = '<div class="search-empty">Escribe para buscar...</div>';
    }
  },

  _closeSearch() {
    document.getElementById('search-overlay').classList.remove('open');
    document.getElementById('search-input').value = '';
    const toolbarInput = document.getElementById('toolbar-search-input');
    toolbarInput.value = '';
    toolbarInput.blur();
  },

  async _doSearch() {
    const query = document.getElementById('search-input').value.trim();
    const container = document.getElementById('search-results');

    if (!query || query.length < 2) {
      container.innerHTML = '<div class="search-empty">Escribe al menos 2 caracteres...</div>';
      this._searchIndex = -1;
      return;
    }

    try {
      const results = await this.invoke('search_vault', {
        path: this.state.vaultPath,
        query,
      });

      if (results.length === 0) {
        container.innerHTML = '<div class="search-empty">Sin resultados para "' + query + '"</div>';
        this._searchIndex = -1;
        return;
      }

      container.innerHTML = '';
      this._searchIndex = 0;

      for (const r of results) {
        const item = document.createElement('div');
        item.className = 'search-result';

        const badgeClass = r.match_type === 'name' ? 'name' : 'content';
        const badgeText = r.match_type === 'name' ? 'nombre' : 'L' + r.line;

        // Highlight query in name and preview
        const highlightedName = this._highlightText(r.name, query);
        const highlightedPreview = r.preview ? this._highlightText(r.preview, query) : '';

        let html = '<div class="search-result-top">'
          + '<span class="search-result-name">' + highlightedName + '</span>'
          + '<span class="search-result-badge ' + badgeClass + '">' + badgeText + '</span>'
          + '</div>';

        if (highlightedPreview) {
          html += '<div class="search-result-preview">' + highlightedPreview + '</div>';
        }

        item.innerHTML = html;
        item.addEventListener('click', () => {
          this._closeSearch();
          this.openNote(r.path, r.name);
        });

        container.appendChild(item);
      }

      this._highlightSearchResult(document.querySelectorAll('.search-result'));

    } catch (err) {
      container.innerHTML = '<div class="search-empty">Error: ' + Util.escapeHtml(err) + '</div>';
    }
  },

  _highlightText(text, query) {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(' + escaped + ')', 'gi');
    // Resaltar sobre el texto crudo y escapar cada fragmento: escapar primero
    // permitia que la busqueda partiera entidades como &amp;lt;.
    return String(text)
      .split(re)
      .map((part, i) => (i % 2 ? '<mark>' + Util.escapeHtml(part) + '</mark>' : Util.escapeHtml(part)))
      .join('');
  },

  _highlightSearchResult(items) {
    items.forEach((item, i) => {
      item.classList.toggle('active', i === this._searchIndex);
    });
    if (items[this._searchIndex]) {
      items[this._searchIndex].scrollIntoView({ block: 'nearest' });
    }
  },

  // -- Helpers -------------------------------------------------------------

  _showWelcome() {
    const html = '<div class="welcome">'
      + '<img class="welcome-logo" src="img/logo.png" alt="POTATO">'
      + '<h1 class="welcome-title">POTATO</h1>'
      + '<p class="welcome-sub">Abre un vault con <kbd>Ctrl+O</kbd> o clona un repo desde el menu.</p>'
      + '<div class="welcome-shortcuts">'
      + '<div class="welcome-row"><kbd>Ctrl+O</kbd><span>Abrir vault</span></div>'
      + '<div class="welcome-row"><kbd>Ctrl+N</kbd><span>Nueva nota</span></div>'
      + '<div class="welcome-row"><kbd>Ctrl+S</kbd><span>Guardar</span></div>'
      + '<div class="welcome-row"><kbd>Ctrl+Shift+S</kbd><span>Sync con GitHub</span></div>'
      + '<div class="welcome-row"><kbd>Ctrl+E</kbd><span>Edit / Read</span></div>'
      + '<div class="welcome-row"><kbd>Ctrl+B</kbd><span>Toggle sidebar</span></div>'
      + '<div class="welcome-row"><kbd>Ctrl+P</kbd><span>Buscar</span></div>'
      + '</div>'
      + '<p class="welcome-credit">Developed by JemXiaoLong</p>'
      + '<p class="welcome-version">v' + this._appVersion + '</p>'
      + '</div>';

    // Mostrar directamente en preview sin pasar por markdown
    const preview = document.getElementById('preview');
    preview.innerHTML = html;

    Editor.hide();
    Preview.show();
  },

  // -- Updates ---------------------------------------------------------------

  // -- What's New tour -------------------------------------------------------

  _whatsNewStep: 0,
  _whatsNewTotal: 0,

  _checkWhatsNew() {
    const seen = localStorage.getItem('potato-whatsnew-version');
    if (seen === this._appVersion) return;
    // No mostrar en primera instalación (sin historial previo)
    if (!seen && !localStorage.getItem('potato-claude-history')) return;
    this._showWhatsNew();
  },

  _showWhatsNew() {
    const modal = document.getElementById('whatsnew-modal');
    const steps = modal.querySelectorAll('.whatsnew-step');
    this._whatsNewTotal = steps.length;
    this._whatsNewStep = 0;

    // Generar dots
    const dotsContainer = document.getElementById('whatsnew-dots');
    dotsContainer.innerHTML = '';
    for (let i = 0; i < this._whatsNewTotal; i++) {
      const dot = document.createElement('div');
      dot.className = 'whatsnew-dot';
      dotsContainer.appendChild(dot);
    }

    // Navegación
    document.getElementById('whatsnew-btn-prev').onclick = () => {
      if (this._whatsNewStep > 0) this._whatsNewGoTo(this._whatsNewStep - 1);
    };
    document.getElementById('whatsnew-btn-next').onclick = () => {
      if (this._whatsNewStep < this._whatsNewTotal - 1) {
        this._whatsNewGoTo(this._whatsNewStep + 1);
      } else {
        this._closeWhatsNew();
      }
    };
    document.getElementById('whatsnew-modal-close').onclick = () => this._closeWhatsNew();

    modal.classList.add('open');
    this._whatsNewGoTo(0);
  },

  _whatsNewGoTo(step) {
    this._whatsNewStep = step;
    const modal = document.getElementById('whatsnew-modal');

    // Ocultar todos, mostrar el actual
    modal.querySelectorAll('.whatsnew-step').forEach((el, i) => {
      el.classList.toggle('hidden', i !== step);
    });

    // Actualizar dots
    document.querySelectorAll('#whatsnew-dots .whatsnew-dot').forEach((dot, i) => {
      dot.classList.toggle('active', i === step);
    });

    // Botón prev
    const prevBtn = document.getElementById('whatsnew-btn-prev');
    prevBtn.style.visibility = step === 0 ? 'hidden' : 'visible';

    // Botón next
    const nextBtn = document.getElementById('whatsnew-btn-next');
    nextBtn.textContent = step < this._whatsNewTotal - 1 ? 'Siguiente' : 'Entendido';
  },

  _closeWhatsNew() {
    localStorage.setItem('potato-whatsnew-version', this._appVersion);
    document.getElementById('whatsnew-modal').classList.remove('open');
  },

  // -- Updates ---------------------------------------------------------------

  // Solo se usa si la API de Tauri no responde; el valor real lo obtiene
  // _loadAppVersion() al iniciar.
  _appVersion: '0.22.1',
  _updateUrl: null,

  async _loadAppVersion() {
    try {
      const version = await window.__TAURI__.app.getVersion();
      if (version) this._appVersion = version;
    } catch (e) {
      console.warn('No se pudo leer la version de la app:', e);
    }
  },

  async _checkForUpdates() {
    try {
      const resp = await fetch('https://api.github.com/repos/JemXiaolong/Potato/releases/latest', {
        headers: { 'Accept': 'application/vnd.github.v3+json' },
      });
      if (!resp.ok) return;

      const data = await resp.json();
      const latest = (data.tag_name || '').replace(/^v/, '');
      if (!latest) return;

      // Comparar versiones
      if (!this._isNewer(latest, this._appVersion)) return;

      // No mostrar si ya dismisseó esta versión
      const dismissed = localStorage.getItem('potato-update-dismissed');
      if (dismissed === latest) return;

      // Buscar asset descargable (.deb o .AppImage)
      const assets = data.assets || [];
      const deb = assets.find(a => a.name.endsWith('.deb'));
      const appimage = assets.find(a => a.name.endsWith('.AppImage'));
      const downloadUrl = (deb || appimage || {}).browser_download_url || data.html_url;

      // Mostrar banner
      this._showUpdateBanner(latest, downloadUrl);
    } catch (_) {
      // Silenciar errores de red — no es crítico
    }
  },

  _isNewer(latest, current) {
    const a = latest.split('.').map(Number);
    const b = current.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((a[i] || 0) > (b[i] || 0)) return true;
      if ((a[i] || 0) < (b[i] || 0)) return false;
    }
    return false;
  },

  _showUpdateBanner(version, url) {
    this._updateUrl = url;
    const banner = document.getElementById('update-banner');
    const btn = document.getElementById('update-link');
    document.getElementById('update-version').textContent = 'v' + version;

    btn.textContent = 'Actualizar';
    btn.disabled = false;
    btn.onclick = () => this._startAutoUpdate();

    document.getElementById('update-close').onclick = () => {
      banner.classList.add('hidden');
      localStorage.setItem('potato-update-dismissed', version);
    };

    banner.classList.remove('hidden');
  },

  async _startAutoUpdate() {
    const btn = document.getElementById('update-link');
    const closeBtn = document.getElementById('update-close');

    // Disable button and hide close
    btn.disabled = true;
    btn.textContent = 'Descargando 0%...';
    closeBtn.style.display = 'none';

    try {
      // Step 1: Download
      const path = await this.invoke('download_update', { url: this._updateUrl });

      // Step 2: Install
      btn.textContent = 'Instalando...';
      await this.invoke('install_update', { path });

      // Step 3: Restart
      btn.textContent = 'Reiniciando...';
      await this.invoke('restart_app');

    } catch (err) {
      // Restore button on error
      btn.disabled = false;
      btn.textContent = 'Actualizar';
      closeBtn.style.display = '';
      this._setStatus(typeof err === 'string' ? err : 'Error al actualizar');
      setTimeout(() => {
        if (this.state.currentNote) {
          this._setStatus(this.state.currentNote.title);
        } else if (this.state.vaultPath) {
          this._setStatus(this.state.vaultPath);
        }
      }, 5000);
    }
  },
};

// Iniciar cuando el DOM este listo
document.addEventListener('DOMContentLoaded', () => App.init());
