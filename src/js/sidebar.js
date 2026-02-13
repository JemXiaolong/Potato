/**
 * Sidebar: renderiza arbol de archivos del vault.
 */
const Sidebar = {
  _container: null,
  _activeItem: null,
  _onSelect: null,

  init(containerId, onSelect) {
    this._container = document.getElementById(containerId);
    this._onSelect = onSelect;
  },

  render(entries) {
    this._container.innerHTML = '';
    this._renderEntries(entries, this._container, 0);
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
    const item = document.createElement('div');
    item.className = 'tree-item dir';
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

    if (entry.children && entry.children.length > 0) {
      const children = document.createElement('div');
      children.className = 'tree-children';
      this._renderEntries(entry.children, children, depth + 1);
      parent.appendChild(children);

      // Start all folders collapsed
      item.classList.add('collapsed');
      children.classList.add('hidden');

      item.addEventListener('click', () => {
        item.classList.toggle('collapsed');
        children.classList.toggle('hidden');
      });
    }
  },

  _renderFile(entry, parent, depth) {
    const item = document.createElement('div');
    item.className = 'tree-item';
    item.dataset.path = entry.path;

    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = '\u25CB'; // ○
    item.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = this._cleanName(entry.name, false);
    item.appendChild(label);

    // Tooltip with full name
    item.title = entry.name;

    item.addEventListener('click', () => {
      this.setActive(entry.path);
      if (this._onSelect) {
        this._onSelect(entry.path, entry.name);
      }
    });

    parent.appendChild(item);
  },
};
