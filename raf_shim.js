// Animation-frame replacement for background tabs (v1.2.5, 2026-11-27)
//
// Chrome pauses requestAnimationFrame in tabs you can't see (minimized window, background tab, screen off).
// The Play Points claim dialog needs it to show its content ("Tap to see your prize") and to finish the prize
// animation ("+N You got N Play Points"). Automatic runs happen in a background tab, so the dialog stayed empty and
// nothing was claimed, while clicking "Check & claim now" with Chrome in front worked.
// This file is loaded at the very start of Play Points pages (manifest content_scripts, world: MAIN). While the tab
// is hidden it drives animation frames with timers; while the tab is visible Chrome's own function is used, so your
// normal browsing of Google Play is not affected.
(() => {
  if (window.__gpRafShim) return;
  window.__gpRafShim = true;
  const nativeRaf = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  const timers = new Map();
  let seq = 1e9;   // keep clear of Chrome's own ids
  window.requestAnimationFrame = function (cb) {
    if (!document.hidden) return nativeRaf(cb);
    const id = seq++;
    timers.set(id, setTimeout(() => { timers.delete(id); cb(performance.now()); }, 16));
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); }
    else nativeCancel(id);
  };
})();
