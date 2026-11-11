/**
 * Preview: renderiza Markdown a HTML con soporte de wikilinks y frontmatter.
 */
const Preview = {
  _el: null,
  _onWikilinkClick: null,


  init(elementId, onWikilinkClick) {
    this._el = document.getElementById(elementId);
    this._onWikilinkClick = onWikilinkClick;

    // Mermaid se carga bajo demanda (Util.ensureMermaid) la primera vez que
    // una nota contiene un diagrama.

    // Configurar marked con highlight.js
    if (typeof marked !== 'undefined') {
      marked.setOptions({
        breaks: true,
        gfm: true,
      });

      const self = this;

      // Custom renderer for code blocks with highlight.js + Mermaid
      const renderer = new marked.Renderer();
      renderer.code = function ({ text, lang }) {
        // Mermaid: renderizar como contenedor de diagrama.
        // The id is derived from the diagram source so re-rendering the same
        // note reuses it and mermaid can skip already-processed diagrams.
        if (lang === 'mermaid') {
          const id = 'mermaid-' + self._hash(text);
          return '<div class="mermaid-container">'
               + '<div class="mermaid" id="' + id + '">' + self._escapeHtml(text) + '</div>'
               + '</div>';
        }
        if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
          const highlighted = hljs.highlight(text, { language: lang }).value;
          return '<pre><code class="hljs language-' + lang + '">' + highlighted + '</code></pre>';
        }
        // Deliberately NO hljs.highlightAuto here. Auto-detection probes every
        // registered language per block, which on a note with ~800 untagged
        // blocks accounted for 3.5s of a 4.4s render. Untagged blocks are shown
        // as plain monospace instead; tag the fence to get colours.
        return '<pre><code class="hljs">' + self._escapeHtml(text) + '</code></pre>';
      };

      marked.use({ renderer });
    }

    // Delegated click handler para links
    this._el.addEventListener('click', (e) => {
      const link = e.target.closest('a');
      if (!link) return;
      e.preventDefault();

      // Wikilinks internos
      if (link.classList.contains('wikilink')) {
        const target = link.dataset.target;
        if (target && this._onWikilinkClick) {
          this._onWikilinkClick(target);
        }
        return;
      }

      const href = link.getAttribute('href');
      if (!href) return;

      // Anclas internas (#seccion): desplazarse al encabezado
      if (href.startsWith('#')) {
        const target = this.revealHeading(decodeURIComponent(href.slice(1)));
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }

      // Links externos → abrir en navegador del sistema
      if (href.startsWith('http://') || href.startsWith('https://')) {
        if (window.__TAURI__) {
          window.__TAURI__.core.invoke('open_in_explorer', { path: href })
            .catch((err) => console.warn('No se pudo abrir el enlace:', err));
        } else {
          window.open(href, '_blank');
        }
        return;
      }

      // Otros esquemas (mailto:, tel:, ...) no son notas del vault
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return;

      // Links relativos → navegar a nota dentro del vault
      if (App.state.currentNote && App.state.vaultPath) {
        const noteDir = App.state.currentNote.path.replace(/[^/]+$/, '');
        // Resolver ruta relativa
        const parts = (noteDir + href).split('/');
        const resolved = [];
        for (const p of parts) {
          if (p === '..') resolved.pop();
          else if (p && p !== '.') resolved.push(p);
        }
        const fullPath = '/' + resolved.join('/');

        // Extraer nombre sin extensión
        const fileName = fullPath.split('/').pop().replace(/\.md$/, '');
        App.openNote(fullPath, fileName);
      }
    });
  },

  // Escape text that goes into HTML as literal content.
  _escapeHtml(text) {
    return Util.escapeHtml(text);
  },

  // Small, fast, non-cryptographic hash (FNV-1a) used to build stable ids.
  _hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return h.toString(36);
  },

  // Extract and parse YAML frontmatter
  _parseFrontmatter(markdown) {
    // Frontmatter can only start at byte 0, so a cheap prefix test avoids
    // running a backtracking regex across the entire document (which on a
    // note without frontmatter scanned megabytes just to fail).
    if (!markdown.startsWith('---')) return { meta: null, body: markdown };

    // Locate the closing delimiter by search rather than regex, and bound the
    // window so a stray leading '---' cannot turn into a full-document scan.
    const limit = Math.min(markdown.length, 64 * 1024);
    const head = markdown.slice(0, limit);
    const close = head.search(/\n---[ \t]*(\n|$)/);
    if (close === -1) return { meta: null, body: markdown };

    const raw = head.slice(head.indexOf('\n') + 1, close);
    const afterDelimiter = markdown.indexOf('\n', close + 1);
    const body = afterDelimiter === -1 ? '' : markdown.slice(afterDelimiter + 1);
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
    return colors[String(status).toLowerCase().replace(/\s*-\s*/g, '-')] || '#6b7280';
  },

  // Status icon mapping
  _statusIcon(status) {
    const s = String(status).toLowerCase();
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
    'version',
  ]),

  // Render frontmatter as a styled card
  _renderFrontmatter(meta) {
    if (!meta) return '';
    // Los valores vienen del archivo: se escapan antes de concatenarlos.
    const m = this._normalizeMeta(meta);
    const esc = (v) => this._escapeHtml(Array.isArray(v) ? v.join(', ') : v);

    let html = '<div class="fm-card">';

    // Header: status pill + type pill + date (right-aligned)
    html += '<div class="fm-header">';
    html += '<div class="fm-pills">';
    if (m.status) {
      const color = this._statusColor(m.status);
      const icon = this._statusIcon(m.status);
      html += '<span class="fm-status" style="--status-color:' + color + '">'
            + icon + ' ' + esc(m.status) + '</span>';
    }
    if (m.type) {
      html += '<span class="fm-type">' + esc(m.type) + '</span>';
    }
    if (m.priority) {
      html += '<span class="fm-priority">' + esc(m.priority) + '</span>';
    }
    html += '</div>';
    if (m.date) {
      html += '<span class="fm-date">' + esc(m.date) + '</span>';
    }
    html += '</div>';

    // Title (if present in frontmatter)
    if (m.title) {
      html += '<div class="fm-title">' + esc(m.title) + '</div>';
    }

    // Project
    if (m.project) {
      html += '<div class="fm-project">' + esc(m.project) + '</div>';
    }

    // Topic (subtitle)
    if (m.topic) {
      html += '<div class="fm-topic">' + esc(m.topic) + '</div>';
    }

    // Description
    if (m.description) {
      html += '<div class="fm-desc">' + esc(m.description) + '</div>';
    }

    // Info row: author, assignee, task_id
    const infoParts = [];
    if (m.author) infoParts.push('<span class="fm-info-item"><span class="fm-info-icon">&#9998;</span>' + esc(m.author) + '</span>');
    if (m.assignee) infoParts.push('<span class="fm-info-item"><span class="fm-info-icon">&#128100;</span>' + esc(m.assignee) + '</span>');
    if (m.task_id) infoParts.push('<span class="fm-info-item fm-task">' + esc(m.task_id) + '</span>');
    if (m.version) infoParts.push('<span class="fm-info-item fm-version">' + esc(m.version) + '</span>');
    if (infoParts.length > 0) {
      html += '<div class="fm-info">' + infoParts.join('') + '</div>';
    }

    // Tags
    if (m.tags && Array.isArray(m.tags) && m.tags.length > 0) {
      html += '<div class="fm-tags">';
      for (const tag of m.tags) {
        html += '<span class="fm-tag">' + esc(tag) + '</span>';
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
        const displayKey = esc(key.replace(/_/g, ' '));
        const displayVal = esc(val);
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

  // -- Sectioned rendering ---------------------------------------------------
  //
  // A 6 MB note expands to 170k+ DOM elements, and building that in one
  // innerHTML assignment freezes the webview for seconds. Instead the token
  // stream is split into sections; only the sections near the viewport hold
  // real DOM, and the rest are empty placeholders keeping their estimated
  // height so the scrollbar stays honest. Sections hydrate and dehydrate as
  // the user scrolls, which bounds DOM size regardless of note length.

  // Source lines per section. Small enough that parsing one costs well under a
  // frame, large enough to keep the section count manageable.
  _maxChunkLines: 220,
  // Below this a heading does not start a new section, so a run of short
  // headings does not produce hundreds of tiny sections.
  _minChunkLines: 60,
  // How far outside the viewport a section still counts as "needed".
  _hydrateMargin: 2000,
  // Sections beyond this distance are dehydrated to release DOM.
  _dehydrateMargin: 6000,

  _chunks: [],
  _headings: [],
  _observer: null,
  _bodyEl: null,

  update(markdown, options) {
    const opts = options || {};
    const scrollTop = this._el.scrollTop;

    // Large notes are where things go wrong, so record how long each stage
    // takes and surface it in the terminal. Cheap and only for big documents.
    const trace = markdown.length > 512 * 1024;
    const t0 = trace ? performance.now() : 0;
    const mark = (stage) => {
      if (!trace) return;
      const ms = (performance.now() - t0).toFixed(0);
      if (typeof App !== 'undefined' && App.log) {
        App.log('perf', `preview.update ${stage} +${ms}ms (${(markdown.length / 1048576).toFixed(1)}MB)`);
      }
    };
    mark('start');

    // Frontmatter only ever sits at the very start, so match against the head
    // instead of scanning megabytes for a delimiter that is not there.
    const { meta, body } = this._parseFrontmatter(markdown);
    mark('frontmatter');

    // Wikilinks must be resolved before the lexer sees the text.
    const processed = Wikilinks.renderInMarkdown(body);
    mark('wikilinks');

    // Secciones ya renderizadas, indexadas por contenido y posicion de sus
    // encabezados. En modo split cada tecla reconstruia todo el preview (y
    // Mermaid redibujaba cada diagrama); ahora solo se re-renderizan las
    // secciones cuyo texto cambio.
    const reusable = new Map();
    for (const c of this._chunks) {
      if (c.rendered && c.el) reusable.set(c.headingStart + '\u0000' + c.text, c.el);
    }

    this._teardown();
    mark('teardown');

    let html = '';
    if (meta) html += this._renderFrontmatter(meta);
    this._el.innerHTML = html + '<div class="pv-body" id="pv-body"></div>';
    this._bodyEl = this._el.querySelector('#pv-body');
    mark('shell');

    if (typeof marked === 'undefined') {
      this._bodyEl.textContent = processed;
      return;
    }

    // The document is sliced as raw text, never lexed as a whole: marked's
    // lexer hangs on multi-megabyte input under JavaScriptCore (WebKitGTK),
    // even though V8 handles the same input in well under a second. Each slice
    // is lexed only when its section is hydrated, so the lexer only ever sees a
    // few kilobytes at a time.
    this._sliceIntoChunks(processed, reusable);
    mark('sliced chunks=' + this._chunks.length + ' headings=' + this._headings.length);

    if (opts.full) {
      this.renderAll();
    } else {
      this._observeChunks();
    }
    mark('observed rendered=' + this._chunks.filter((c) => c.rendered).length);

    this._el.scrollTop = scrollTop;
    mark('done');
  },

  _teardown() {
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    this._chunks = [];
    this._headings = [];
    this._bodyEl = null;
  },

  // Slice the raw markdown into sections in a single line scan.
  //
  // Boundaries are chosen so a slice is always independently parseable:
  //   * never inside a fenced code block (fence state is tracked)
  //   * preferably right before a heading
  //   * otherwise at a blank line, and never where it would cut a table apart
  // Headings are collected in the same pass so the table of contents is
  // available without parsing anything.
  _sliceIntoChunks(text, reusable) {
    const lines = text.split('\n');
    const maxLines = this._maxChunkLines;
    const minLines = this._minChunkLines;

    const chunks = [];
    const headings = [];

    let startLine = 0;
    let inFence = false;
    let fenceMarker = '';
    let headingCursor = 0;
    let headingsInChunk = 0;

    const pushChunk = (endExclusive) => {
      if (endExclusive <= startLine) return;
      const slice = lines.slice(startLine, endExclusive).join('\n');
      chunks.push({
        index: chunks.length,
        text: slice,
        lineCount: endExclusive - startLine,
        headingStart: headingCursor,
        headingCount: headingsInChunk,
        estHeight: this._estimateHeight(slice, endExclusive - startLine),
        rendered: false,
        el: null,
      });
      headingCursor += headingsInChunk;
      headingsInChunk = 0;
      startLine = endExclusive;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Track fenced blocks. Only a fence of the same kind and at least the
      // same length closes an open fence.
      const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fence) {
        if (!inFence) {
          inFence = true;
          fenceMarker = fence[1][0].repeat(3);
        } else if (fence[1][0] === fenceMarker[0]) {
          inFence = false;
          fenceMarker = '';
        }
        continue;
      }
      if (inFence) continue;

      const heading = line.match(/^(#{1,6})\s+(.*\S)\s*$/);
      if (heading) {
        // Break before this heading when the current slice is already big
        // enough, so sections line up with document structure.
        if (i - startLine >= minLines) pushChunk(i);

        const raw = heading[2].replace(/\s*#+\s*$/, '');
        const clean = raw
          .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, a, b) => b || a)
          .replace(/<[^>]+>/g, '')
          .replace(/[*_`]/g, '')
          .trim();
        const slug = clean.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
        headings.push({
          id: slug + '-' + headings.length,
          text: clean,
          level: heading[1].length,
        });
        headingsInChunk++;
        continue;
      }

      // Hard cap: split at a blank line, but not where the next content line
      // continues a table, which would strand rows without their header.
      if (i - startLine >= maxLines && line.trim() === '') {
        let next = i + 1;
        while (next < lines.length && lines[next].trim() === '') next++;
        const continuesTable = next < lines.length && /^\s{0,3}\|/.test(lines[next]);
        if (!continuesTable) pushChunk(i + 1);
      }
    }

    pushChunk(lines.length);

    this._chunks = chunks;
    this._headings = headings;

    // Placeholders are created in one pass so layout settles once.
    const fragment = document.createDocumentFragment();
    for (const chunk of chunks) {
      const section = document.createElement('section');
      section.className = 'pv-chunk';
      section.dataset.chunk = String(chunk.index);
      chunk.el = section;

      const key = chunk.headingStart + '\u0000' + chunk.text;
      const previous = reusable && reusable.get(key);
      if (previous) {
        // Mover los nodos ya renderizados (incluidos SVG de Mermaid).
        reusable.delete(key);
        while (previous.firstChild) section.appendChild(previous.firstChild);
        chunk.rendered = true;
      } else {
        section.style.minHeight = chunk.estHeight + 'px';
      }
      fragment.appendChild(section);
    }
    this._bodyEl.appendChild(fragment);
  },

  // Rough height guess from the slice's source text. Only needs to be close
  // enough to keep the scrollbar proportional; the real height replaces it as
  // soon as the section hydrates.
  _estimateHeight(slice, lineCount) {
    // Wrapping means long lines occupy more than one rendered row.
    const wrapped = Math.ceil(slice.length / 110);
    return Math.max(Math.max(lineCount, wrapped) * 22, 24);
  },

  _observeChunks() {
    if (typeof IntersectionObserver === 'undefined') {
      // Without the observer there is no safe way to lazily hydrate, so fall
      // back to rendering everything.
      this.renderAll();
      return;
    }

    this._observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const chunk = this._chunks[Number(entry.target.dataset.chunk)];
          if (!chunk) continue;
          if (entry.isIntersecting) this._hydrate(chunk);
        }
      },
      { root: this._el, rootMargin: this._hydrateMargin + 'px 0px' }
    );

    for (const chunk of this._chunks) this._observer.observe(chunk.el);

    // The observer only fires after a layout pass, so prime the top of the
    // document synchronously to avoid a visible blank flash on open.
    const initial = Math.min(this._chunks.length, 4);
    for (let i = 0; i < initial; i++) this._hydrate(this._chunks[i]);

    this._scheduleDehydrate();
  },

  _hydrate(chunk) {
    if (chunk.rendered) return;

    let html;
    try {
      // Only this slice is parsed, never the whole document.
      html = Util.renderMarkdown(chunk.text);
    } catch (e) {
      console.warn('Chunk render error:', e);
      html = '<p class="pv-chunk-error">No se pudo renderizar esta seccion.</p>';
    }

    chunk.el.innerHTML = html;
    chunk.rendered = true;

    // Heading ids are assigned from the precomputed list so anchors stay
    // consistent whether or not neighbouring sections are rendered.
    const nodes = chunk.el.querySelectorAll('h1, h2, h3, h4, h5, h6');
    nodes.forEach((node, i) => {
      const heading = this._headings[chunk.headingStart + i];
      if (heading) node.id = heading.id;
    });

    // Once real content is in place the estimate must not constrain it.
    chunk.el.style.minHeight = '';
    this._renderMermaidIn(chunk.el);
  },

  _dehydrate(chunk, measuredHeight) {
    if (!chunk.rendered) return;
    // Freeze the measured height so removing the content does not shift scroll.
    const measured = measuredHeight ?? chunk.el.offsetHeight;
    chunk.estHeight = measured || chunk.estHeight;
    chunk.el.style.minHeight = chunk.estHeight + 'px';
    chunk.el.innerHTML = '';
    chunk.rendered = false;
  },

  _scheduleDehydrate() {
    if (this._dehydrateBound) return;
    this._dehydrateBound = () => {
      clearTimeout(this._dehydrateTimer);
      this._dehydrateTimer = setTimeout(() => this._dehydrateFar(), 400);
    };
    this._el.addEventListener('scroll', this._dehydrateBound, { passive: true });
  },

  _dehydrateFar() {
    if (!this._chunks.length) return;
    const top = this._el.scrollTop;
    const bottom = top + this._el.clientHeight;
    // Medir todo primero y mutar despues: intercalar lecturas de offsetTop
    // con escrituras al DOM forzaba un reflow por cada seccion.
    const far = [];
    for (const chunk of this._chunks) {
      if (!chunk.rendered) continue;
      const elTop = chunk.el.offsetTop;
      const height = chunk.el.offsetHeight;
      const elBottom = elTop + height;
      const distance = elTop > bottom ? elTop - bottom : top - elBottom;
      if (distance > this._dehydrateMargin) far.push([chunk, height]);
    }
    for (const [chunk, height] of far) this._dehydrate(chunk, height);
  },

  /**
   * Force every section into the DOM. Needed before printing, where the whole
   * document must exist at once, and as the fallback when lazy hydration is
   * unavailable. Returns a promise so callers can await diagram rendering.
   */
  async renderAll() {
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    for (const chunk of this._chunks) this._hydrate(chunk);
    await this._renderMermaidIn(this._el);
  },

  /** Hydrate whatever section holds this heading, then return its element. */
  revealHeading(id) {
    const target = this._el.querySelector('#' + CSS.escape(id));
    if (target) return target;

    const position = this._headings.findIndex((h) => h.id === id);
    if (position === -1) return null;

    const chunk = this._chunks.find(
      (c) => position >= c.headingStart && position < c.headingStart + c.headingCount
    );
    if (!chunk) return null;

    this._hydrate(chunk);
    return this._el.querySelector('#' + CSS.escape(id));
  },

  _renderMermaidIn(root) {
    return Util.renderMermaidIn(root);
  },

  getHeadings() {
    // Read from the token stream, not the DOM: headings in unhydrated sections
    // must still appear in the table of contents.
    return this._headings.slice();
  },

  show() {
    this._el.classList.add('visible');
  },

  hide() {
    this._el.classList.remove('visible');
  },

  clear() {
    this._teardown();
    this._el.innerHTML = '';
  },
};
