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

    // Inicializar componentes
    Sidebar.init(
      'file-tree',
      (path, name) => this.openNote(path, name),
      (filePath, fileName, destDir) => this._onFileDrop(filePath, fileName, destDir),
    );

    Editor.init('editor', (content) => {
      this.state.dirty = true;
      Preview.update(content);
      this._updateToc();

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

    // Mostrar welcome si no hay nota abierta
    if (!this.state.currentNote) {
      this._showWelcome();
    }

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

    // Notificar a Claude del nuevo vault
    Claude.onVaultChanged();
    Claude.updateContext();

    // Guardar sesion
    this._saveSession();
  },

  async refreshVault() {
    if (!this.state.vaultPath) return;
    await this._updateChangedFiles();
    const entries = await this.invoke('list_vault', { path: this.state.vaultPath });
    Sidebar.render(entries);
  },

  // -- Notes ---------------------------------------------------------------

  async openNote(path, title) {
    // Auto-guardar nota actual
    await this.saveCurrentNote();

    const content = await this.invoke('read_note', { path });
    if (content === null) return;

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

    Editor.setValue(content);
    this._setTitle(title);
    this._setStatus(title);

    // Mostrar controles de nota
    document.getElementById('mode-toggle').classList.remove('hidden');
    document.getElementById('close-note-btn').classList.remove('hidden');
    document.getElementById('split-btn').classList.remove('hidden');
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
    document.getElementById('note-nav').classList.add('hidden');

    // Reset split mode, TOC, and clean up
    const content = document.querySelector('.content');
    content.classList.remove('split-mode');
    content.classList.remove('toc-visible');
    document.getElementById('toc-panel').classList.add('hidden');
    this.state.mode = 'read';
    Editor.setValue('');
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
    await this.openNote(path, title);
    this._navInProgress = false;
  },

  async _noteNavForward() {
    if (this._noteHistoryIndex >= this._noteHistory.length - 1) return;
    this._noteHistoryIndex++;
    const { path, title } = this._noteHistory[this._noteHistoryIndex];
    this._navInProgress = true;
    await this.openNote(path, title);
    this._navInProgress = false;
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
    await this.invoke('save_note', {
      path: this.state.currentNote.path,
      content,
    });
    this._lastSavedContent = content;
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

      const path = await this.invoke('create_note', {
        vaultPath: this.state.vaultPath,
        name,
      });

      await this.refreshVault();
      await this.openNote(path, name);
    };
  },

  // -- Wikilinks -----------------------------------------------------------

  async onWikilinkClick(target) {
    if (!this.state.vaultPath) return;

    // Buscar la nota en el vault
    const entries = await this.invoke('list_vault', { path: this.state.vaultPath });
    const found = this._findEntry(entries, target);

    if (found) {
      await this.openNote(found.path, found.name);
    } else {
      // Crear nota si no existe
      const path = await this.invoke('create_note', {
        vaultPath: this.state.vaultPath,
        name: target,
      });
      await this.refreshVault();
      await this.openNote(path, target);
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

  setMode(mode) {
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
      Preview.update(Editor.getValue());
      Editor.show();
      Preview.show();
      Editor.focus();
    } else {
      Preview.update(Editor.getValue());
      Editor.hide();
      Preview.show();
    }

    // Update TOC after mode change
    this._updateToc();
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
    const handle = document.getElementById('sidebar-resize');
    let startX, startWidth;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = document.body.style.getPropertyValue('--sidebar-w')
        ? parseInt(document.body.style.getPropertyValue('--sidebar-w'))
        : 240;

      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = (e) => {
        const diff = e.clientX - startX;
        const newWidth = Math.max(160, Math.min(600, startWidth + diff));
        document.documentElement.style.setProperty('--sidebar-w', newWidth + 'px');
      };

      const onUp = () => {
        handle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
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

    // Escape para cerrar search o nota
    if (e.key === 'Escape') {
      if (document.getElementById('search-overlay').classList.contains('open')) {
        this._closeSearch();
      } else if (this.state.currentNote) {
        this.closeNote();
      }
    }
  },

  // -- Menu ----------------------------------------------------------------

  _initMenu() {
    const btn = document.getElementById('menu-btn');
    const dropdown = document.getElementById('menu-dropdown');

    // Toggle menu
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('open');
    });

    // Close on click outside
    document.addEventListener('click', () => {
      dropdown.classList.remove('open');
    });

    // Prevent closing when clicking inside menu
    dropdown.addEventListener('click', (e) => {
      e.stopPropagation();
    });

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

    list.innerHTML = '';
    for (const h of headings) {
      const item = document.createElement('div');
      item.className = 'toc-item h' + h.level;
      item.textContent = h.text;
      item.addEventListener('click', () => {
        const target = document.getElementById(h.id);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
      list.appendChild(item);
    }

    panel.classList.remove('hidden');
    content.classList.add('toc-visible');
  },

  // -- External change detection -----------------------------------------------

  _focusCooldown: false,

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
      const diskContent = await this.invoke('read_note', { path: this.state.currentNote.path });

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
          // No local changes: reload silently
          Editor.setValue(diskContent);
          this._lastSavedContent = diskContent;
          Preview.update(diskContent);
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
      container.innerHTML = '<div class="search-empty">Error: ' + err + '</div>';
    }
  },

  _highlightText(text, query) {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(' + escaped + ')', 'gi');
    return text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(re, '<mark>$1</mark>');
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

  _appVersion: '0.18.3',
  _updateUrl: null,

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
