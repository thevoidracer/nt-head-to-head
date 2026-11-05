// The toolbar icon has no popup — the real UI lives inside nitrotype.com
// itself (see content/inject.js). Clicking the icon just tells the content
// script on the active tab to toggle that panel open, as a backup way in
// if the injected nav tab is ever hard to find (e.g. narrow window).
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "ntcmp:toggle" }).catch(() => {
    // Not on nitrotype.com, or the content script hasn't loaded yet — nothing to do.
  });
});
