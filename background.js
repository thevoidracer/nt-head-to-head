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

// ---------------------------------------------------------------------
// Your own progress snapshots + daily streak. Nitro Type's own racer page
// dropped its season/daily breakdown a while back, so there's no "recent
// form" anywhere on the real site anymore — this re-creates it by taking
// one snapshot of your own racer's stats per calendar day (UTC) on this
// same alarm, same reasoning as the team checks above: it has to live
// here, not in the content script, so a day still gets recorded even if
// no nitrotype.com tab happens to be open that day.
// ---------------------------------------------------------------------

function utcDateKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

async function checkMyProgress() {
  const stored = await storageGet(["ntcmp:myRacer", "ntcmp:progressSnapshots", "ntcmp:dailyGoal", "ntcmp:streakCount", "ntcmp:streakLastDate"]);
  const myRacer = stored["ntcmp:myRacer"];
  if (!myRacer) return;

  let snapshots = stored["ntcmp:progressSnapshots"] || [];
  const dailyGoal = stored["ntcmp:dailyGoal"] || 0;
  let streakCount = stored["ntcmp:streakCount"] || 0;
  let streakLastDate = stored["ntcmp:streakLastDate"] || null;

  let racer;
  try {
    racer = await NT.fetchRacer(myRacer);
  } catch (e) {
    return; // flaky fetch or username changed — try again next check
  }

  const today = utcDateKey(Date.now());
  const last = snapshots[snapshots.length - 1];
  const beforeToday = last && utcDateKey(last.ts) !== today ? last : [...snapshots].reverse().find((s) => utcDateKey(s.ts) !== today);

  if (last && utcDateKey(last.ts) === today) {
    // Already have today's entry — just refresh it with the latest numbers.
    last.racesPlayed = racer.racesPlayed;
    last.avgSpeed = racer.avgSpeed;
    last.highestSpeed = racer.highestSpeed;
  } else {
    snapshots.push({ ts: Date.now(), racesPlayed: racer.racesPlayed, avgSpeed: racer.avgSpeed, highestSpeed: racer.highestSpeed });
  }
  snapshots = snapshots.slice(-60); // ~60 days at one entry/day

  // Credit (or break) today's streak once, against yesterday's baseline —
  // approximate by design: it only measures races between recorded
  // snapshots, so a day with no snapshot (extension never ran that day)
  // is simply not measured rather than guessed at.
  if (dailyGoal && beforeToday && streakLastDate !== today) {
    const current = snapshots[snapshots.length - 1];
    const delta = (current.racesPlayed || 0) - (beforeToday.racesPlayed || 0);
    const yesterday = utcDateKey(Date.now() - 86400000);
    streakCount = delta >= dailyGoal ? (streakLastDate === yesterday ? streakCount + 1 : 1) : 0;
    streakLastDate = today;
  }

  // Track the best streak ever reached, separately from the current one,
  // so a broken streak doesn't erase the milestone of having hit it —
  // this is what the achievements/milestones feature checks against.
  const stored2 = await storageGet(["ntcmp:bestStreak"]);
  const bestStreak = Math.max(stored2["ntcmp:bestStreak"] || 0, streakCount);

  await storageSet({
    "ntcmp:progressSnapshots": snapshots,
    "ntcmp:streakCount": streakCount,
    "ntcmp:streakLastDate": streakLastDate,
    "ntcmp:bestStreak": bestStreak,
  });
}

// ---------------------------------------------------------------------
// Captain roster trends — a day-over-day per-member snapshot of your own
// team's race counts, so the roster view can show who's improving, who's
// stalled, and who's been quiet, instead of just today's numbers. Same
// "has to live here" reasoning as the progress snapshot above: a day
// still gets recorded even with no nitrotype.com tab open.
// ---------------------------------------------------------------------

async function checkMyRosterSnapshot() {
  const stored = await storageGet(["ntcmp:myTeam", "ntcmp:rosterSnapshots"]);
  const myTeam = stored["ntcmp:myTeam"];
  if (!myTeam) return;

  let team;
  try {
    team = await NT.fetchTeam(myTeam);
  } catch (e) {
    return; // flaky fetch — try again next check
  }

  const all = stored["ntcmp:rosterSnapshots"] || {};
  const prevForTeam = all[myTeam] || {};
  const today = utcDateKey(Date.now());
  const curMembers = {};
  let totalPlayed = 0;
  for (const m of team.members || []) {
    if (!m.username) continue;
    curMembers[m.username] = { played: m.played || 0, displayName: m.displayName || m.username };
    totalPlayed += m.played || 0;
  }

  let next;
  if (prevForTeam.curDate === today) {
    // Already have today's snapshot — just refresh it, keep yesterday's as-is.
    next = { ...prevForTeam, curMembers };
  } else {
    // A new day — roll today's snapshot back to "previous" so there's
    // always a day-over-day baseline to diff against.
    next = { prevDate: prevForTeam.curDate || null, prevMembers: prevForTeam.curMembers || {}, curDate: today, curMembers };
  }
  all[myTeam] = next;

  // A rolling log of (timestamp, team-wide total races) samples at this
  // same 30-minute cadence, kept separately from the day-over-day roster
  // snapshot above — this is what the activity-heatmap feature buckets by
  // hour of day. Capped at ~7 days of samples.
  const logStored = await storageGet(["ntcmp:teamActivityLog"]);
  const logAll = logStored["ntcmp:teamActivityLog"] || {};
  const log = (logAll[myTeam] || []).concat([{ ts: Date.now(), totalPlayed }]).slice(-340);
  logAll[myTeam] = log;

  await storageSet({ "ntcmp:rosterSnapshots": all, "ntcmp:teamActivityLog": logAll });
}

// ---------------------------------------------------------------------
// Rival tracking — a short list of other racers (built from the "+ Rival"
// button on the on-page racer comparison badge) this alarm re-checks
// against your own racer's current avg speed, firing a notification the
// moment the lead between you and one of them flips either way.
// ---------------------------------------------------------------------

async function checkRivals(myRacerData) {
  const stored = await storageGet(["ntcmp:rivals", "ntcmp:rivalSnapshots"]);
  const rivals = stored["ntcmp:rivals"] || [];
  if (!rivals.length) return;
  const snapshots = stored["ntcmp:rivalSnapshots"] || {};
  const nextSnapshots = { ...snapshots };

  for (const username of rivals) {
    try {
      const theirs = await NT.fetchRacer(username);
      const nowLeading = (myRacerData?.avgSpeed || 0) >= (theirs.avgSpeed || 0);
      const prev = snapshots[username];
      if (prev && prev.leading !== nowLeading) {
        chrome.notifications.create(`ntcmp:rival:${username}:${Date.now()}`, {
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon128.png"),
          title: nowLeading ? `TypeTrack — You passed ${theirs.displayName}!` : `TypeTrack — ${theirs.displayName} passed you`,
          message: `Avg speed: you ${myRacerData?.avgSpeed ?? "—"} wpm vs ${theirs.displayName} ${theirs.avgSpeed} wpm.`,
        });
      }
      nextSnapshots[username] = { avgSpeed: theirs.avgSpeed, leading: nowLeading };
    } catch (e) {
      // Renamed or unreachable this round — keep the old snapshot.
    }
  }
  await storageSet({ "ntcmp:rivalSnapshots": nextSnapshots });
}

async function checkMyRacerDrivenTasks() {
  const { "ntcmp:myRacer": myRacer, "ntcmp:rivals": rivals } = await storageGet(["ntcmp:myRacer", "ntcmp:rivals"]);
  await checkMyProgress();
  if (myRacer && rivals && rivals.length) {
    try {
      const myRacerData = await NT.fetchRacer(myRacer);
      await checkRivals(myRacerData);
    } catch (e) {
      // Can't compare without your own fresh stats this round — skip.
    }
  }
}

function ensureAlarm() {
  chrome.alarms.get(WATCH_ALARM, (existing) => {
    if (!existing) chrome.alarms.create(WATCH_ALARM, { periodInMinutes: 30 });
  });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== WATCH_ALARM) return;
  checkWatchedTeams();
  checkMyRacerDrivenTasks();
  checkMyRosterSnapshot();
});

// A team just got starred in the Teams tab — grab its baseline snapshot
// right away rather than waiting for the next scheduled check (nothing to
// diff against yet, so this never fires a notification on its own).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "ntcmp:watchAdded" && msg.tag) {
    checkWatchedTeams({ notifyOnChange: false });
  }
  if (msg && msg.type === "ntcmp:rivalAdded") {
    checkMyRacerDrivenTasks();
  }
});
