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

// ---------------------------------------------------------------------
// Watched-team change notifications. The content script (content/inject.js)
// just owns the short "watch" list the user builds from the Teams tab's
// star button — this service worker is what actually re-checks those teams
// on a timer (it keeps running, independent of any nitrotype.com tab being
// open) and fires a desktop notification when something worth flagging
// changed: a new captain, a changed requirement, or a sizeable member
// swing. Reuses the same NT.fetchTeam() the content script uses, loaded
// via importScripts since a service worker can't reach into a tab's script
// context — host_permissions for nitrotype.com is what lets this fetch
// succeed cross-origin from here without running into CORS.
// ---------------------------------------------------------------------

importScripts("lib/nt.js");

const WATCH_ALARM = "ntcmp:watchCheck";
const MEMBER_SWING_THRESHOLD = 5;

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

async function checkWatchedTeams({ notifyOnChange = true } = {}) {
  const stored = await storageGet(["ntcmp:watchedTeams", "ntcmp:watchSnapshots"]);
  const watched = stored["ntcmp:watchedTeams"] || [];
  const snapshots = stored["ntcmp:watchSnapshots"] || {};
  if (!watched.length) return;

  const nextSnapshots = { ...snapshots };
  for (const tag of watched) {
    try {
      const team = await NT.fetchTeam(tag);
      const snap = {
        captain: team.info?.displayName || team.info?.username || null,
        minRaces: team.trend?.minRaces ?? 0,
        minSpeed: team.info?.minSpeed ?? 0,
        members: team.memberCount ?? 0,
      };
      const prev = snapshots[tag];
      if (notifyOnChange && prev) {
        const changes = [];
        if (prev.captain && snap.captain && prev.captain !== snap.captain) {
          changes.push(`New captain: ${snap.captain} (was ${prev.captain})`);
        }
        if (prev.minRaces !== snap.minRaces) {
          changes.push(`Min races now ${snap.minRaces} (was ${prev.minRaces})`);
        }
        if (prev.minSpeed !== snap.minSpeed) {
          changes.push(`Min speed now ${snap.minSpeed} (was ${prev.minSpeed})`);
        }
        if (Math.abs(snap.members - prev.members) >= MEMBER_SWING_THRESHOLD) {
          changes.push(`Members ${snap.members > prev.members ? "up" : "down"} to ${snap.members} (was ${prev.members})`);
        }
        if (changes.length) {
          chrome.notifications.create(`ntcmp:watch:${tag}:${Date.now()}`, {
            type: "basic",
            iconUrl: chrome.runtime.getURL("icons/icon128.png"),
            title: `TypeTrack — [${tag}] changed`,
            message: changes.join(" · "),
          });
        }
      }
      nextSnapshots[tag] = snap;
    } catch (e) {
      // Renamed, disbanded, or just a flaky fetch this round — keep the
      // old snapshot and try again on the next scheduled check.
    }
  }
  await storageSet({ "ntcmp:watchSnapshots": nextSnapshots });
}

function ensureAlarm() {
  chrome.alarms.get(WATCH_ALARM, (existing) => {
    if (!existing) chrome.alarms.create(WATCH_ALARM, { periodInMinutes: 30 });
  });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCH_ALARM) checkWatchedTeams();
});

// A team just got starred in the Teams tab — grab its baseline snapshot
// right away rather than waiting for the next scheduled check (nothing to
// diff against yet, so this never fires a notification on its own).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "ntcmp:watchAdded" && msg.tag) {
    checkWatchedTeams({ notifyOnChange: false });
  }
});
