/**
 * Parser de wikilinks [[target]] y [[target|display]]
 */
const Wikilinks = {
  PATTERN: /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,

  /**
   * Reemplaza [[links]] en texto markdown con HTML antes del render.
   */
  renderInMarkdown(text) {
    return text.replace(this.PATTERN, (_match, target, display) => {
      const label = display || target;
      return `<a class="wikilink" data-target="${this._escape(target)}" href="#">${this._escape(label)}</a>`;
    });
  },

  /**
   * Extrae todos los targets de wikilinks.
   */
  parse(text) {
    const links = [];
    let match;
    const re = new RegExp(this.PATTERN.source, 'g');
    while ((match = re.exec(text)) !== null) {
      links.push({
        target: match[1],
        display: match[2] || match[1],
      });
    }
    return links;
  },

  _escape(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },
};
