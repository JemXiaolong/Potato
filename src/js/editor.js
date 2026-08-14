/**
 * Editor: wrapper del textarea con helpers.
 */
const Editor = {
  _el: null,
  _onChange: null,

  init(elementId, onChange) {
    this._el = document.getElementById(elementId);
    this._onChange = onChange;

    // Debounced input handler. The delay scales with document size: on a
    // multi-megabyte note the downstream work (lexing the whole document) costs
    // far more than 150 ms, so firing that often just queues up work the user
    // outruns anyway.
    let timeout;
    this._el.addEventListener('input', () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        if (this._onChange) {
          this._onChange(this._el.value);
        }
      }, this._debounceFor(this._el.value.length));
    });

    // Tab key inserts spaces
    this._el.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = this._el.selectionStart;
        // setRangeText edits in place. Rebuilding value from two substrings
        // copied the entire document twice per Tab press.
        this._el.setRangeText('    ', start, this._el.selectionEnd, 'end');
        this._el.dispatchEvent(new Event('input'));
      }
    });
  },

  /** Input debounce in ms, widened for large documents. */
  _debounceFor(length) {
    if (length > 4 * 1024 * 1024) return 900;
    if (length > 1024 * 1024) return 500;
    if (length > 256 * 1024) return 300;
    return 150;
  },

  getValue() {
    return this._el.value;
  },

  /**
   * Replace the editor contents.
   *
   * Pass { silent: true } when loading a note from disk. The change callback
   * marks the document dirty and rebuilds the preview, neither of which is
   * correct for content that was just read from the file.
   */
  setValue(content, options) {
    this._el.value = content;
    if ((options && options.silent) || !this._onChange) return;
    this._onChange(content);
  },

  show() {
    this._el.classList.remove('hidden');
  },

  hide() {
    this._el.classList.add('hidden');
  },

  focus() {
    this._el.focus();
  },
};
