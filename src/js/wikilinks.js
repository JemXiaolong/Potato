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
      return `<a class="wikilink" data-target="${Util.escapeHtml(target)}" href="#">${Util.escapeHtml(label)}</a>`;
    });
  },
};
