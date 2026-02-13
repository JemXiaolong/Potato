/**
 * Editor: wrapper del textarea con helpers.
 */
const Editor = {
  _el: null,
  _onChange: null,

  init(elementId, onChange) {
    this._el = document.getElementById(elementId);
    this._onChange = onChange;

    // Debounced input handler
    let timeout;
    this._el.addEventListener('input', () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        if (this._onChange) {
          this._onChange(this._el.value);
        }
      }, 150);
    });

    // Tab key inserts spaces
    this._el.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = this._el.selectionStart;
        const end = this._el.selectionEnd;
        this._el.value =
          this._el.value.substring(0, start) +
          '    ' +
          this._el.value.substring(end);
        this._el.selectionStart = this._el.selectionEnd = start + 4;
        this._el.dispatchEvent(new Event('input'));
      }
    });
  },

  getValue() {
    return this._el.value;
  },

  setValue(content) {
    this._el.value = content;
    // Trigger change callback
    if (this._onChange) {
      this._onChange(content);
    }
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
