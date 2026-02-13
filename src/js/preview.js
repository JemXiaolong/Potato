/**
 * Preview: renderiza Markdown a HTML con soporte de wikilinks y frontmatter.
 */
const Preview = {
  _el: null,
  _onWikilinkClick: null,

  init(elementId, onWikilinkClick) {
    this._el = document.getElementById(elementId);
    this._onWikilinkClick = onWikilinkClick;

    // Configurar marked con highlight.js
    if (typeof marked !== 'undefined') {
      marked.setOptions({
        breaks: true,
        gfm: true,
      });

      // Custom renderer for code blocks with highlight.js
      const renderer = new marked.Renderer();
      renderer.code = function ({ text, lang }) {
        if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
          const highlighted = hljs.highlight(text, { language: lang }).value;
          return '<pre><code class="hljs language-' + lang + '">' + highlighted + '</code></pre>';
        }
        if (typeof hljs !== 'undefined') {
          const highlighted = hljs.highlightAuto(text).value;
          return '<pre><code class="hljs">' + highlighted + '</code></pre>';
        }
        return '<pre><code>' + text + '</code></pre>';
      };

      marked.use({ renderer });
    }

    // Delegated click handler para wikilinks
    this._el.addEventListener('click', (e) => {
      const link = e.target.closest('a.wikilink');
      if (link) {
        e.preventDefault();
        const target = link.dataset.target;
        if (target && this._onWikilinkClick) {
          this._onWikilinkClick(target);
        }
      }
    });
  },

  // Extract and parse YAML frontmatter
  _parseFrontmatter(markdown) {
    const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!match) return { meta: null, body: markdown };

    const raw = match[1];
    const body = match[2];
    const meta = {};

    for (const line of raw.split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      // Remove quotes
      val = val.replace(/^["']|["']$/g, '');
      // Parse arrays [a, b, c]
      if (val.startsWith('[') && val.endsWith(']')) {
        val = val.slice(1, -1).split(',').map(s => s.trim());
      }
      meta[key] = val;
    }

    return { meta, body };
  },

  // Field name normalization (Spanish → English)
  _fieldAliases: {
    estado: 'status', fecha: 'date', proyecto: 'project',
    tema: 'topic', autor: 'author', etiquetas: 'tags',
    titulo: 'title', descripcion: 'description', tipo: 'type',
    prioridad: 'priority', asignado: 'assignee', version: 'version',
  },

  // Normalize field names to support both languages
  _normalizeMeta(meta) {
    const normalized = {};
    for (const [key, val] of Object.entries(meta)) {
      const norm = this._fieldAliases[key.toLowerCase()] || key.toLowerCase();
      normalized[norm] = val;
    }
    return normalized;
  },

  // Status color mapping
  _statusColor(status) {
    const colors = {
      draft: '#f59e0b', borrador: '#f59e0b',
      'in-progress': '#3b82f6', 'in_progress': '#3b82f6',
      'en-progreso': '#3b82f6', 'en_progreso': '#3b82f6',
      review: '#8b5cf6', revision: '#8b5cf6', 'revisión': '#8b5cf6',
      done: '#10b981', completed: '#10b981', completado: '#10b981',
      implementado: '#10b981',
      archived: '#6b7280', archivado: '#6b7280',
      pending: '#f59e0b', pendiente: '#f59e0b',
      cancelled: '#ef4444', cancelado: '#ef4444',
    };
    return colors[status.toLowerCase().replace(/\s*-\s*/g, '-')] || '#6b7280';
  },

  // Status icon mapping
  _statusIcon(status) {
    const s = status.toLowerCase();
    if (s.includes('draft') || s.includes('borrador')) return '&#9998;';
    if (s.includes('progress') || s.includes('progreso')) return '&#9881;';
    if (s.includes('review') || s.includes('revis')) return '&#128270;';
    if (s.includes('done') || s.includes('complet') || s.includes('implement')) return '&#10003;';
    if (s.includes('pending') || s.includes('pendiente')) return '&#9203;';
    if (s.includes('archived') || s.includes('archivado')) return '&#128451;';
    if (s.includes('cancel')) return '&#10007;';
    return '&#9679;';
  },

  // Known fields that get special rendering (skip from generic list)
  _specialFields: new Set([
    'status', 'date', 'title', 'project', 'topic', 'author',
    'task_id', 'tags', 'type', 'priority', 'assignee', 'description',
  ]),

  // Render frontmatter as a styled card
  _renderFrontmatter(meta) {
    if (!meta) return '';
    const m = this._normalizeMeta(meta);

    let html = '<div class="fm-card">';

    // Header: status pill + type pill + date (right-aligned)
    html += '<div class="fm-header">';
    html += '<div class="fm-pills">';
    if (m.status) {
      const color = this._statusColor(m.status);
      const icon = this._statusIcon(m.status);
      html += '<span class="fm-status" style="--status-color:' + color + '">'
            + icon + ' ' + m.status + '</span>';
    }
    if (m.type || m.tipo) {
      const t = m.type || m.tipo;
      html += '<span class="fm-type">' + t + '</span>';
    }
    if (m.priority) {
      html += '<span class="fm-priority">' + m.priority + '</span>';
    }
    html += '</div>';
    if (m.date) {
      html += '<span class="fm-date">' + m.date + '</span>';
    }
    html += '</div>';

    // Title (if present in frontmatter)
    if (m.title) {
      html += '<div class="fm-title">' + m.title + '</div>';
    }

    // Project
    if (m.project) {
      html += '<div class="fm-project">' + m.project + '</div>';
    }

    // Topic (subtitle)
    if (m.topic) {
      html += '<div class="fm-topic">' + m.topic + '</div>';
    }

    // Description
    if (m.description) {
      html += '<div class="fm-desc">' + m.description + '</div>';
    }

    // Info row: author, assignee, task_id
    const infoParts = [];
    if (m.author) infoParts.push('<span class="fm-info-item"><span class="fm-info-icon">&#9998;</span>' + m.author + '</span>');
    if (m.assignee) infoParts.push('<span class="fm-info-item"><span class="fm-info-icon">&#128100;</span>' + m.assignee + '</span>');
    if (m.task_id) infoParts.push('<span class="fm-info-item fm-task">' + m.task_id + '</span>');
    if (m.version) infoParts.push('<span class="fm-info-item fm-version">' + m.version + '</span>');
    if (infoParts.length > 0) {
      html += '<div class="fm-info">' + infoParts.join('') + '</div>';
    }

    // Tags
    if (m.tags && Array.isArray(m.tags) && m.tags.length > 0) {
      html += '<div class="fm-tags">';
      for (const tag of m.tags) {
        html += '<span class="fm-tag">' + tag + '</span>';
      }
      html += '</div>';
    }

    // Generic fields (anything not in the special list)
    const genericFields = Object.entries(m).filter(
      ([k]) => !this._specialFields.has(k)
    );
    if (genericFields.length > 0) {
      html += '<div class="fm-extra">';
      for (const [key, val] of genericFields) {
        const displayKey = key.replace(/_/g, ' ');
        const displayVal = Array.isArray(val) ? val.join(', ') : val;
        html += '<div class="fm-extra-row">'
              + '<span class="fm-extra-key">' + displayKey + '</span>'
              + '<span class="fm-extra-val">' + displayVal + '</span>'
              + '</div>';
      }
      html += '</div>';
    }

    html += '</div>';
    return html;
  },

  update(markdown) {
    // Preservar scroll
    const scrollTop = this._el.scrollTop;

    // Parse frontmatter
    const { meta, body } = this._parseFrontmatter(markdown);

    // Procesar wikilinks antes de marked
    const processed = Wikilinks.renderInMarkdown(body);

    // Render markdown a HTML
    let html = '';
    if (meta) {
      html += this._renderFrontmatter(meta);
    }

    if (typeof marked !== 'undefined') {
      html += marked.parse(processed);
    } else {
      html += processed;
    }

    this._el.innerHTML = html;
    this._el.scrollTop = scrollTop;
  },

  show() {
    this._el.classList.add('visible');
  },

  hide() {
    this._el.classList.remove('visible');
  },

  clear() {
    this._el.innerHTML = '';
  },
};
