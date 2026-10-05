// Small interactions shared by every page: theme toggle, language switch memory, copy buttons.
(function () {
  var root = document.documentElement;
  function set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  function current() {
    var t = root.getAttribute('data-theme');
    if (t === 'light' || t === 'dark') return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
    function label() {
      var ru = root.lang === 'ru';
      var next = current() === 'dark' ? 'light' : 'dark';
      b.setAttribute('aria-label', ru ? (next === 'dark' ? 'Тёмная тема' : 'Светлая тема') : 'Switch to ' + next + ' theme');
      b.title = b.getAttribute('aria-label');
    }
    label();
    b.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      set('agento-theme', next);
      label();
      document.dispatchEvent(new CustomEvent('agento:theme'));
    });
  });

  // Choosing a language by hand is remembered, so the unprefixed pages stop redirecting.
  document.querySelectorAll('[data-set-lang]').forEach(function (a) {
    a.addEventListener('click', function () { set('agento-lang', a.getAttribute('data-set-lang')); });
  });

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy failed')); } catch (e) { reject(e); }
      document.body.removeChild(ta);
    });
  }

  document.querySelectorAll('[data-copy]').forEach(function (b) {
    var live = b.querySelector('[aria-live]');
    b.addEventListener('click', function () {
      copyText(b.getAttribute('data-copy')).then(function () {
        b.classList.add('is-copied');
        if (live) live.textContent = root.lang === 'ru' ? 'Скопировано' : 'Copied';
        window.setTimeout(function () { b.classList.remove('is-copied'); if (live) live.textContent = ''; }, 1600);
      }, function () { /* clipboard blocked: the command stays visible on the button */ });
    });
  });
})();
