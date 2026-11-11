/* Runs before the page is drawn: decides whether to show the loader
   (first visit of the session only) and switches on the animations. */
(function () {
  var d = document.documentElement;
  d.classList.add('js');
  var seen = false;
  try { seen = sessionStorage.getItem('rb-intro') === '1'; } catch (e) {}
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!seen && !reduce) d.classList.add('is-loading');
  /* If the page is framed by another site, break out of it (anti-clickjacking) */
  if (window.top !== window.self) {
    try { window.top.location = window.self.location; } catch (e) { d.style.display = 'none'; }
  }
})();
