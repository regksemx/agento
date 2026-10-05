// Runs in <head> before first paint: applies the saved theme and picks the language page.
// English pages live at the root, Russian ones under /ru/. `?lang=ru|en` is an explicit, shareable choice.
(function () {
  var root = document.documentElement;
  function get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private mode: fine */ } }

  var theme = get('agento-theme');
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);

  var lang = root.lang === 'ru' ? 'ru' : 'en';
  var other = lang === 'ru' ? 'en' : 'ru';
  var alt = document.querySelector('link[rel="alternate"][hreflang="' + other + '"]');
  var m = /[?&]lang=(ru|en)\b/.exec(window.location.search);
  var want = null;

  if (m) {
    want = m[1];
    set('agento-lang', want);
  } else if (lang === 'en') {
    // The unprefixed pages follow the remembered choice, or the browser language on a first visit.
    want = get('agento-lang');
    if (want !== 'ru' && want !== 'en') {
      var nav = (navigator.languages && navigator.languages[0]) || navigator.language || '';
      want = /^ru\b/i.test(nav) ? 'ru' : 'en';
      set('agento-lang', want);
    }
  }
  if (want && want !== lang && alt) window.location.replace(alt.href + window.location.hash);
})();
