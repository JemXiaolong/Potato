/**
 * Sidebar: renderiza arbol de archivos del vault.
 */
const Sidebar = {
  _container: null,
  _activeItem: null,
  _onSelect: null,
  _onDrop: null,
  _dragData: null,  // { path, name } of file being dragged
  _changedPaths: new Set(),  // absolute paths of unsynced files

  init(containerId, onSelect, onDrop) {
    this._container = document.getElementById(containerId);
    this._onSelect = onSelect;
    this._onDrop = onDrop;

    // Allow dropping on the root (sidebar-tree container)
    this._container.addEventListener('dragover', (e) => {
      // Only allow if dragging over the container itself, not a child dir
      if (e.target === this._container || e.target.classList.contains('sidebar-empty')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        this._container.classList.add('drag-over-root');
      }
    });

    this._container.addEventListener('dragleave', (e) => {
      if (e.target === this._container || e.target.classList.contains('sidebar-empty')) {
        this._container.classList.remove('drag-over-root');
      }
    });

    this._container.addEventListener('drop', (e) => {
      this._container.classList.remove('drag-over-root');
      if (!this._dragData) return;
      // Only handle drops on the container itself (root level)
      if (e.target !== this._container && !e.target.classList.contains('sidebar-empty')) return;
      e.preventDefault();

      if (this._onDrop) {
        // vault root path = container parent's vault path
        this._onDrop(this._dragData.path, this._dragData.name, null);
      }
      this._dragData = null;
    });
  },

  setChangedFiles(absolutePaths) {
    this._changedPaths = new Set(absolutePaths);
  },

  render(entries) {
    // Save expanded directories before re-render
    const expanded = new Set();
    this._container.querySelectorAll('.tree-item.dir:not(.collapsed)').forEach(el => {
      if (el.dataset.path) expanded.add(el.dataset.path);
    });

    this._container.innerHTML = '';
    this._renderEntries(entries, this._container, 0);

    // Restore expanded directories
    if (expanded.size > 0) {
      expanded.forEach(path => {
        const item = this._container.querySelector(`.tree-item.dir[data-path="${CSS.escape(path)}"]`);
        if (item && item.classList.contains('collapsed')) {
          item.classList.remove('collapsed');
          const children = item.nextElementSibling;
          if (children && children.classList.contains('tree-children')) {
            children.classList.remove('hidden');
          }
        }
      });
    }
  },

  clear() {
    this._container.innerHTML = '<div class="sidebar-empty">Ctrl+O para abrir un vault</div>';
    this._activeItem = null;
  },

  setActive(path) {
    if (this._activeItem) {
      this._activeItem.classList.remove('active');
    }
    const item = this._container.querySelector(`[data-path="${CSS.escape(path)}"]`);
    if (item) {
      item.classList.add('active');
      this._activeItem = item;
    }
  },

  // Clean display name: strip date prefixes, replace separators
  _cleanName(name, isDir) {
    if (isDir) return name;
    // Strip date prefix like "2025-12-15-" from filenames
    let clean = name.replace(/^\d{4}-\d{2}-\d{2}-/, '');
    // Strip task prefix like "tXXXXX-"
    clean = clean.replace(/^t\d{4,6}-/, '');
    // Replace underscores and hyphens with spaces
    clean = clean.replace(/[_-]/g, ' ');
    // Capitalize first letter
    clean = clean.charAt(0).toUpperCase() + clean.slice(1);
    return clean;
  },

  // Check if any file in entries (recursive) is unsynced
  _hasUnsyncedFiles(entries) {
    for (const entry of entries) {
      if (entry.is_dir && entry.children) {
        if (this._hasUnsyncedFiles(entry.children)) return true;
      } else if (!entry.is_dir && this._changedPaths.has(entry.path)) {
        return true;
      }
    }
    return false;
  },

  // Count total files (recursive)
  _countFiles(entries) {
    let count = 0;
    for (const entry of entries) {
      if (entry.is_dir && entry.children) {
        count += this._countFiles(entry.children);
      } else if (!entry.is_dir) {
        count++;
      }
    }
    return count;
  },

  _renderEntries(entries, parent, depth) {
    for (const entry of entries) {
      if (entry.is_dir) {
        this._renderDir(entry, parent, depth);
      } else {
        this._renderFile(entry, parent, depth);
      }
    }
  },

  _renderDir(entry, parent, depth) {
    const dirHasUnsynced = entry.children && this._hasUnsyncedFiles(entry.children);

    const item = document.createElement('div');
    item.className = 'tree-item dir' + (dirHasUnsynced ? ' unsynced' : '');
    item.dataset.path = entry.path;

    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = '\u25BE'; // ▾
    item.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = entry.name;
    item.appendChild(label);

    // File count badge
    if (entry.children && entry.children.length > 0) {
      const count = this._countFiles([entry]);
      const badge = document.createElement('span');
      badge.className = 'tree-badge';
      badge.textContent = count;
      item.appendChild(badge);
    }

    parent.appendChild(item);

    let children = null;

    if (entry.children && entry.children.length > 0) {
      children = document.createElement('div');
      children.className = 'tree-children';
      this._renderEntries(entry.children, children, depth + 1);
      parent.appendChild(children);

      // Start all folders collapsed
      item.classList.add('collapsed');
      children.classList.add('hidden');

      item.addEventListener('click', (e) => {
        // Don't toggle if the click was from a drop event area
        if (e.target.closest('.tree-item') !== item) return;
        item.classList.toggle('collapsed');
        children.classList.toggle('hidden');
      });
    }

    // -- Drop target for directories --
    this._setupDropTarget(item, entry, children);
  },

  _setupDropTarget(item, entry, childrenEl) {
    let expandTimeout = null;

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      item.classList.add('drag-over');

      // Auto-expand collapsed folders after hovering 600ms
      if (childrenEl && item.classList.contains('collapsed')) {
        if (!expandTimeout) {
          expandTimeout = setTimeout(() => {
            item.classList.remove('collapsed');
            childrenEl.classList.remove('hidden');
          }, 600);
        }
      }
    });

    item.addEventListener('dragleave', (e) => {
      // Only remove if we're actually leaving this item
      if (!item.contains(e.relatedTarget) || e.relatedTarget === item) {
        item.classList.remove('drag-over');
      }
      if (expandTimeout) {
        clearTimeout(expandTimeout);
        expandTimeout = null;
      }
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      item.classList.remove('drag-over');

      if (expandTimeout) {
        clearTimeout(expandTimeout);
        expandTimeout = null;
      }

      if (!this._dragData) return;

      // Don't drop on the same parent directory
      const filePath = this._dragData.path;
      const fileDir = filePath.substring(0, filePath.lastIndexOf('/'));
      if (fileDir === entry.path) return;

      if (this._onDrop) {
        this._onDrop(this._dragData.path, this._dragData.name, entry.path);
      }
      this._dragData = null;
    });
  },

  _renderFile(entry, parent, depth) {
    const isUnsynced = this._changedPaths.has(entry.path);

    const item = document.createElement('div');
    item.className = 'tree-item' + (isUnsynced ? ' unsynced' : '');
    item.dataset.path = entry.path;

    // Make file draggable
    item.draggable = true;

    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = isUnsynced ? '\u25CF' : '\u25CB'; // ● vs ○
    item.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = this._cleanName(entry.name, false);
    item.appendChild(label);

    // Sync badge for unsynced files
    if (isUnsynced) {
      const badge = document.createElement('span');
      badge.className = 'tree-sync-badge';
      badge.textContent = 'sync';
      item.appendChild(badge);
    }

    // Tooltip with full name
    item.title = entry.name;

    item.addEventListener('click', () => {
      this.setActive(entry.path);
      if (this._onSelect) {
        this._onSelect(entry.path, entry.name);
      }
    });

    // Drag events
    item.addEventListener('dragstart', (e) => {
      this._dragData = { path: entry.path, name: entry.name };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', entry.path);
      // Visual feedback
      requestAnimationFrame(() => item.classList.add('dragging'));
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      this._dragData = null;
      // Clean up any lingering drag-over states
      this._container.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      this._container.classList.remove('drag-over-root');
    });

    parent.appendChild(item);
  },
};
