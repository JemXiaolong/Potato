/**
 * App: logica principal, estado, atajos de teclado.
 */
const App = {
  // Estado
  state: {
    vaultPath: null,
    currentNote: null, // { path, title }
    mode: 'read',       // 'edit' | 'read'
    dirty: false,
    gitLinked: false,   // vault is a git repo with remote
  },

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
    Sidebar.init('file-tree', (path, name) => this.openNote(path, name));

    Editor.init('editor', (content) => {
      this.state.dirty = true;
      Preview.update(content);
    });

    Preview.init('preview', (target) => this.onWikilinkClick(target));

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => this._onKeyDown(e));

    // Mode toggle buttons
    document.querySelectorAll('.toggle-btn').forEach((btn) => {
      btn.addEventListener('click', () => this.setMode(btn.dataset.mode));
    });

    // Menu dropdown
    this._initMenu();

    // Sync button
    document.getElementById('sync-btn').addEventListener('click', () => this.gitSync());

    // Sidebar resize
    this._initSidebarResize();

    // Listen for git progress events
    this._initProgressBar();

    // Mostrar welcome
    this._showWelcome();
  },

  // -- Vault ---------------------------------------------------------------

  async openVault() {
    const path = await this.invoke('open_vault');
    if (!path) return;
    await this._loadVault(path);
  },

  async _loadVault(path) {
    this.state.vaultPath = path;

    const entries = await this.invoke('list_vault', { path });
    Sidebar.render(entries);

    // UI updates
    const name = path.split('/').pop();
    document.getElementById('vault-name').textContent = name.toUpperCase();
    this._setStatus(path);
    this._setTitle('');

    // Limpiar editor
    Editor.setValue('');
    Preview.clear();
    this.state.currentNote = null;

    // Check git status
    await this._checkGitStatus();
  },

  async refreshVault() {
    if (!this.state.vaultPath) return;
    const entries = await this.invoke('list_vault', { path: this.state.vaultPath });
    Sidebar.render(entries);
  },

  // -- Notes ---------------------------------------------------------------

  async openNote(path, title) {
    // Auto-guardar nota actual
    await this.saveCurrentNote();

    const content = await this.invoke('read_note', { path });
    if (content === null) return;

    this.state.currentNote = { path, title };
    this.state.dirty = false;

    Editor.setValue(content);
    this._setTitle(title);
    this._setStatus(title);

    // Actualizar la vista activa
    if (this.state.mode === 'read') {
      Preview.update(content);
    }

    Sidebar.setActive(path);
    if (this.state.mode === 'edit') {
      Editor.focus();
    }
  },

  async saveCurrentNote() {
    if (!this.state.currentNote || !this.state.dirty) return;

    await this.invoke('save_note', {
      path: this.state.currentNote.path,
      content: Editor.getValue(),
    });
    this.state.dirty = false;
    this._setStatus('Guardado');
    setTimeout(() => {
      if (this.state.currentNote) {
        this._setStatus(this.state.currentNote.title);
      }
    }, 1500);
  },

  async createNote() {
    if (!this.state.vaultPath) {
      alert('Primero abre un vault (Ctrl+O)');
      return;
    }

    const name = prompt('Nombre de la nota:');
    if (!name || !name.trim()) return;

    const path = await this.invoke('create_note', {
      vaultPath: this.state.vaultPath,
      name: name.trim(),
    });

    await this.refreshVault();
    await this.openNote(path, name.trim());
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

    // Toggle buttons
    document.querySelectorAll('.toggle-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    if (mode === 'edit') {
      Editor.show();
      Preview.hide();
      Editor.focus();
    } else {
      Preview.update(Editor.getValue());
      Editor.hide();
      Preview.show();
    }
  },

  toggleMode() {
    this.setMode(this.state.mode === 'edit' ? 'read' : 'edit');
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

  async _showGitHubDialog() {
    const url = prompt('URL del repositorio GitHub:\n\nEjemplo: https://github.com/usuario/mi-vault.git');
    if (!url || !url.trim()) return;

    // Ask where to clone
    this._setStatus('Selecciona carpeta destino...');
    const destFolder = await this.invoke('pick_folder');
    if (!destFolder) {
      this._setStatus('Cancelado');
      return;
    }

    // Build clone path: destFolder/repoName
    const repoName = url.trim().split('/').pop().replace('.git', '') || 'vault';
    const clonePath = destFolder + '/' + repoName;

    this._setStatus('Clonando repositorio...');
    this._showProgress();
    try {
      const result = await this.invoke('git_clone', { url: url.trim(), path: clonePath });
      this._hideProgress();
      this._setStatus('Clonado exitosamente');

      // Open cloned repo as vault
      await this._loadVault(result);
    } catch (err) {
      this._hideProgress();
      this._showGitError(err, 'clonar');
    }
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

  // Step 3: Commit message
  _syncStepCommit() {
    if (this._syncState.selectedFiles.length === 0) {
      this._closeSyncModal();
      return;
    }

    this._syncShowStep('commit');
    const input = document.getElementById('sync-commit-msg');
    const actionBtn = document.getElementById('sync-btn-action');

    // Default message
    const now = new Date();
    const timestamp = now.toISOString().slice(0, 16).replace('T', ' ');
    input.value = '';
    input.placeholder = 'vault sync ' + timestamp;
    input.focus();

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
    const now = new Date();
    const timestamp = now.toISOString().slice(0, 16).replace('T', ' ');
    const message = input.value.trim() || 'vault sync ' + timestamp;

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

  _openInExplorer() {
    if (!this.state.vaultPath) {
      alert('Primero abre un vault (Ctrl+O)');
      return;
    }
    if (this.invoke) {
      this.invoke('open_in_explorer', { path: this.state.vaultPath });
    }
  },

  _showSettings() {
    // TODO: Panel de ajustes
    alert('Ajustes (proximamente)\n\n- Tema claro/oscuro\n- Tamano de fuente\n- Auto-guardado\n- Atajos de teclado');
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

  // -- Helpers -------------------------------------------------------------

  _setTitle(text) {
    document.getElementById('note-title').textContent = text;
  },

  _setStatus(text) {
    document.getElementById('status-text').textContent = text;
  },

  _showWelcome() {
    const welcome = [
      '# POTATO',
      '',
      'Abre un vault con **Ctrl+O** o clona un repo desde el menu.',
      '',
      '---',
      '',
      '**Atajos**',
      '',
      '| Atajo | Accion |',
      '|---|---|',
      '| `Ctrl+O` | Abrir vault |',
      '| `Ctrl+N` | Nueva nota |',
      '| `Ctrl+S` | Guardar |',
      '| `Ctrl+Shift+S` | Sync con GitHub |',
      '| `Ctrl+E` | Edit / Read |',
      '| `Ctrl+B` | Toggle sidebar |',
      '',
      'Usa `[[nombre]]` para enlazar notas.',
      '',
      '---',
      '',
      '`Developed by JemXiaoLong`',
    ].join('\n');

    Editor.setValue(welcome);
    this.setMode('read');
  },
};

// Iniciar cuando el DOM este listo
document.addEventListener('DOMContentLoaded', () => App.init());
