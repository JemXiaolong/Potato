/**
 * Utilidades compartidas por los modulos del frontend.
 *
 * Se carga antes que wikilinks/sidebar/editor/preview/claude/app.
 */
const Util = {
  /** Escapa texto para insertarlo como contenido o atributo HTML. */
  escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  /**
   * Sanitiza HTML generado a partir de Markdown (notas o respuestas de Claude).
   *
   * Con `withGlobalTauri` activo, un script inyectado en una nota podria
   * invocar comandos del backend (escribir archivos, instalar paquetes...).
   * DOMPurify elimina scripts, manejadores on* y URLs javascript:, pero
   * conserva clases, ids y atributos data-* que usan wikilinks, highlight.js
   * y Mermaid.
   */
  sanitize(html) {
    if (typeof DOMPurify === 'undefined') return html;
    return DOMPurify.sanitize(html);
  },

  /** Convierte Markdown a HTML sanitizado. */
  renderMarkdown(markdown) {
    return this.sanitize(marked.parse(markdown));
  },

  // -- UI: resizers y menus emergentes --------------------------------------

  /**
   * Permite redimensionar arrastrando `handleId`, escribiendo el ancho en la
   * variable CSS `cssVar` de :root, acotado a [min, max].
   */
  makeResizer(handleId, cssVar, min, max, fallback) {
    const handle = document.getElementById(handleId);
    if (!handle) return;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const root = document.documentElement;
      const startWidth = parseInt(getComputedStyle(root).getPropertyValue(cssVar), 10) || fallback;

      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = (ev) => {
        const width = Math.max(min, Math.min(max, startWidth + ev.clientX - startX));
        root.style.setProperty(cssVar, width + 'px');
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

  _popups: [],

  /**
   * Menu emergente: `btn` lo abre/cierra; un clic fuera o Escape lo cierra.
   * Todos los menus comparten un unico par de listeners en document (antes
   * cada menu registraba los suyos).
   */
  bindPopup(btn, menu) {
    if (!btn || !menu) return;
    if (this._popups.length === 0) {
      const closeAll = () => this._popups.forEach((m) => m.classList.remove('open'));
      document.addEventListener('click', closeAll);
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeAll();
      });
    }
    this._popups.push(menu);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !menu.classList.contains('open');
      this._popups.forEach((m) => m.classList.remove('open'));
      menu.classList.toggle('open', willOpen);
    });
    menu.addEventListener('click', (e) => e.stopPropagation());
  },

  // -- Mermaid (carga diferida) ---------------------------------------------

  _mermaidPromise: null,

  /**
   * Carga e inicializa Mermaid la primera vez que se necesita.
   *
   * La libreria pesa ~3.5 MB; cargarla con un <script> en index.html la
   * parseaba en cada arranque aunque la nota no tuviera diagramas.
   */
  ensureMermaid() {
    if (this._mermaidPromise) return this._mermaidPromise;
    this._mermaidPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'js/vendor/mermaid.min.js';
      script.onload = () => {
        mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          themeVariables: {
            darkMode: true,
            background: '#0d1117',
            primaryColor: '#1a3a5c',
            primaryTextColor: '#d6deeb',
            primaryBorderColor: '#1d3b53',
            secondaryColor: '#1e3a5f',
            secondaryTextColor: '#c8d6e5',
            tertiaryColor: '#152d4a',
            lineColor: '#5f7e97',
            textColor: '#d6deeb',
            mainBkg: '#1a3a5c',
            nodeBorder: '#5f7e97',
            clusterBkg: '#0d1b2a',
            clusterBorder: '#1d3b53',
            titleColor: '#c792ea',
            edgeLabelBackground: '#0d1117',
            nodeTextColor: '#d6deeb',
          },
          fontFamily: '"JetBrains Mono", "Fira Code", monospace',
          fontSize: 14,
          flowchart: { curve: 'basis', padding: 20 },
          sequence: { mirrorActors: false, bottomMarginAdj: 1 },
        });
        resolve(mermaid);
      };
      script.onerror = () => {
        this._mermaidPromise = null;
        reject(new Error('No se pudo cargar Mermaid'));
      };
      document.head.appendChild(script);
    });
    return this._mermaidPromise;
  },

  /**
   * Renderiza los diagramas Mermaid pendientes dentro de `root`.
   * Los errores (p. ej. un diagrama incompleto durante el streaming) se
   * registran pero no se propagan.
   */
  async renderMermaidIn(root) {
    if (!root) return;
    const nodes = root.querySelectorAll('.mermaid:not([data-processed])');
    if (nodes.length === 0) return;
    try {
      const lib = await this.ensureMermaid();
      await lib.run({ nodes });
    } catch (e) {
      console.warn('Mermaid render error:', e);
    }
  },
};
