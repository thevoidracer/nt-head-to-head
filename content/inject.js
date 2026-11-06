// Injects a "Head-to-Head" tab into Nitro Type's own nav bar, and a
// slide-in comparison panel (in a Shadow DOM, so none of Nitro Type's CSS
// leaks in and none of ours leaks onto their page). Self-heals if Nitro
// Type's client-side router ever re-renders the nav and wipes our tab.

(function () {
  "use strict";

  if (window.__ntcmpInjected) return;
  window.__ntcmpInjected = true;

  const NAV_TAB_ID = "ntcmp-nav-tab";
  let panelApi = null; // set once the panel is built

  function storageGet(key) {
    return new Promise((resolve) => chrome.storage.local.get([key], (r) => resolve(r[key])));
  }
  function storageSet(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  }

  // ---------------------------------------------------------------------
  // Shared team list — a small, separate database (not the TypeTrack
  // website's own) that every install of this extension reads from and
  // writes to anonymously. Any team any TypeTrack user compares, looks
  // up, or visits the page of gets pushed here, so it shows up in every
  // other install's Teams tab too — not just the one person who found
  // it. Backed by a public, no-login Supabase table, since Nitro Type
  // itself has no "every team" endpoint to seed from.
  // ---------------------------------------------------------------------

  const SharedTeams = (() => {
    const ENDPOINT = "https://povaenzmktegkgxfbcbi.supabase.co/rest/v1/shared_teams";
    const KEY = "sb_publishable_xF29hhiE7UvqL0G4oU8-_Q__qL0aHt2";
    const headers = { apikey: KEY, "Content-Type": "application/json" };

    function toRemote(entry) {
      return {
        tag: entry.tag,
        name: entry.name,
        color: entry.color,
        captain: entry.captain,
        members: entry.members,
        formed: entry.formed,
        min_races: entry.minRaces,
        min_speed: entry.minSpeed,
        synced_at: entry.syncedAt,
        updated_at: new Date().toISOString(),
      };
    }

    function fromRemote(row) {
      return {
        tag: row.tag,
        name: row.name,
        color: row.color,
        captain: row.captain,
        members: row.members,
        formed: row.formed,
        minRaces: row.min_races,
        minSpeed: row.min_speed,
        syncedAt: row.synced_at,
      };
    }

    // Fire-and-forget: never blocks or throws into the caller. Every
    // install is an anonymous writer, so a flaky connection just means
    // this one team doesn't sync this particular time — not fatal.
    function push(entry) {
      fetch(ENDPOINT, {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify(toRemote(entry)),
      }).catch(() => {});
    }

    async function pullAll() {
      try {
        const res = await fetch(`${ENDPOINT}?select=*`, { headers });
        if (!res.ok) return [];
        return (await res.json()).map(fromRemote);
      } catch (e) {
        return [];
      }
    }

    return { push, pullAll };
  })();

  // ---------------------------------------------------------------------
  // Shared racer leaderboard — the cross-install twin of SharedTeams
  // above, but for the computed mega-leaderboard rows themselves (one
  // row per racer: username, team, lifetime races, avg speed) rather
  // than team summaries. Every install that builds the leaderboard
  // contributes its freshly-fetched rows here, and every install reads
  // this table first so it doesn't have to refetch hundreds of team
  // rosters itself just to see a leaderboard someone else already
  // built. Backed by its own Supabase table (see the SQL this ships
  // with) — if that table doesn't exist yet in a given Supabase
  // project, every call here just fails quietly and the extension
  // falls back to building the leaderboard locally.
  // ---------------------------------------------------------------------

  const SharedRacers = (() => {
    const ENDPOINT = "https://povaenzmktegkgxfbcbi.supabase.co/rest/v1/shared_racers";
    const KEY = "sb_publishable_xF29hhiE7UvqL0G4oU8-_Q__qL0aHt2";
    const headers = { apikey: KEY, "Content-Type": "application/json" };
    const PAGE_SIZE = 1000;

    function toRemote(r) {
      return {
        username: r.username,
        display_name: r.displayName,
        tag: r.tag,
        races_played: r.racesPlayed || 0,
        avg_speed: r.avgSpeed || 0,
        updated_at: new Date().toISOString(),
      };
    }

    function fromRemote(row) {
      return {
        username: row.username,
        displayName: row.display_name || row.username,
        tag: row.tag,
        racesPlayed: row.races_played || 0,
        avgSpeed: row.avg_speed || 0,
      };
    }

    // Fire-and-forget, chunked so a leaderboard of several thousand rows
    // doesn't go out as one giant request. Every install is an anonymous
    // writer, same as SharedTeams — a flaky connection or a missing table
    // just means this batch doesn't sync this time, not fatal.
    async function pushAll(rows) {
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500).map(toRemote);
        try {
          await fetch(ENDPOINT, {
            method: "POST",
            headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify(chunk),
          });
        } catch (e) {
          // Skip this chunk — not fatal to the rest.
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    async function pullAll() {
      const rows = [];
      let offset = 0;
      try {
        while (true) {
          const res = await fetch(`${ENDPOINT}?select=username,display_name,tag,races_played,avg_speed&order=races_played.desc`, {
            headers: { ...headers, Range: `${offset}-${offset + PAGE_SIZE - 1}` },
          });
          if (!res.ok && res.status !== 206) break;
          const page = await res.json();
          if (!Array.isArray(page) || !page.length) break;
          rows.push(...page);
          if (page.length < PAGE_SIZE) break;
          offset += PAGE_SIZE;
        }
      } catch (e) {
        return [];
      }
      return rows.map(fromRemote);
    }

    return { pushAll, pullAll };
  })();

  // ---------------------------------------------------------------------
  // Team directory — the "known teams" the compare fields autocomplete
  // and the Browse list draw from. Grows two ways: explicitly, every time
  // a team is looked up in the compare form or the roster finder; and
  // passively, every time this tab visits a team's own page on
  // nitrotype.com. Seeded once from SEED_TEAM_TAGS (lib/seed-teams.js) so
  // Browse isn't empty on day one — see that file for why it's a curated
  // starter list, not a claim of completeness.
  // ---------------------------------------------------------------------

  const TeamDirectory = (() => {
    let teams = [];
    let seenCount = 0;
    const subscribers = [];

    async function load() {
      teams = (await storageGet("ntcmp:knownTeams")) || [];
      const storedSeen = await storageGet("ntcmp:teamsSeenCount");
      // First run: baseline to the current count so the "new since you last
      // looked" badge doesn't fire on a list you've never actually opened.
      seenCount = storedSeen == null ? teams.length : storedSeen;
      if (storedSeen == null) await storageSet({ "ntcmp:teamsSeenCount": seenCount });
      notify();
    }

    // Accepts the full object NT.fetchTeam() resolves with — not just a
    // tag/name pair — so the Teams tab can render real cards (captain,
    // member count, formed date, requirements, team color) without a
    // second fetch. Fields missing from a given snapshot (e.g. an older
    // stored entry from before this existed, or a passive capture that
    // only had the basics) fall back to whatever was already known.
    async function remember(team) {
      const clean = (team?.tag || "").trim().toUpperCase();
      if (!clean) return;
      const idx = teams.findIndex((t) => t.tag === clean);
      const existing = idx >= 0 ? teams[idx] : null;
      const entry = {
        tag: clean,
        name: team.name || existing?.name || clean,
        color: team.info?.tagColor || existing?.color || null,
        captain: team.info?.displayName || team.info?.username || existing?.captain || null,
        members: team.memberCount ?? existing?.members ?? null,
        formed: team.info?.createdStamp ? team.info.createdStamp * 1000 : existing?.formed ?? null,
        minRaces: team.trend?.minRaces ?? team.info?.minRaces ?? existing?.minRaces ?? 0,
        minSpeed: team.info?.minSpeed ?? existing?.minSpeed ?? 0,
        syncedAt: Date.now(),
      };
      if (idx >= 0) teams[idx] = entry;
      else teams.unshift(entry);
      teams = teams.slice(0, 400);
      await storageSet({ "ntcmp:knownTeams": teams });
      notify();
      SharedTeams.push(entry);
    }

    // Folds in rows pulled from the shared list (see SharedTeams above).
    // Only overwrites a team we already know about if the shared copy is
    // newer — never stomps a fresher local lookup with a stale one.
    async function mergeRemote(remoteTeams) {
      let changed = false;
      for (const r of remoteTeams) {
        const clean = (r.tag || "").trim().toUpperCase();
        if (!clean) continue;
        const idx = teams.findIndex((t) => t.tag === clean);
        const existing = idx >= 0 ? teams[idx] : null;
        if (existing && (existing.syncedAt || 0) >= (r.syncedAt || 0)) continue;
        const entry = {
          tag: clean,
          name: r.name || existing?.name || clean,
          color: r.color || existing?.color || null,
          captain: r.captain || existing?.captain || null,
          members: r.members ?? existing?.members ?? null,
          formed: r.formed ?? existing?.formed ?? null,
          minRaces: r.minRaces ?? existing?.minRaces ?? 0,
          minSpeed: r.minSpeed ?? existing?.minSpeed ?? 0,
          syncedAt: r.syncedAt ?? existing?.syncedAt ?? Date.now(),
        };
        if (idx >= 0) teams[idx] = entry;
        else teams.unshift(entry);
        changed = true;
      }
      if (changed) {
        teams = teams.slice(0, 400);
        await storageSet({ "ntcmp:knownTeams": teams });
        notify();
      }
    }

    function list() {
      return teams.slice();
    }

    // How many teams have arrived (locally or via the shared list) since
    // the Teams tab was last actually opened — drives the small counter
    // badge on the nav tab so there's a signal without opening it.
    function unseenCount() {
      return Math.max(0, teams.length - seenCount);
    }
    async function markSeen() {
      seenCount = teams.length;
      await storageSet({ "ntcmp:teamsSeenCount": seenCount });
      notify();
    }

    function subscribe(fn) {
      subscribers.push(fn);
    }

    function notify() {
      subscribers.forEach((fn) => fn(teams));
    }

    async function seedOnce() {
      const alreadySeeded = await storageGet("ntcmp:seeded");
      if (alreadySeeded) return;
      await storageSet({ "ntcmp:seeded": true });
      const queue = (typeof SEED_TEAM_TAGS !== "undefined" ? SEED_TEAM_TAGS : []).slice();
      const worker = async () => {
        while (queue.length) {
          const tag = queue.shift();
          try {
            const team = await NT.fetchTeam(tag);
            await remember(team);
          } catch (e) {
            // Tag may be renamed or disbanded since the seed list was
            // captured — just skip it, this isn't fatal to anything.
          }
          // A small, steady gap between requests — this only ever runs
          // once per install, so there's no rush, and spacing it out
          // keeps it from tripping NT's own rate limiting (which could
          // otherwise spill over into an unrelated Compare lookup
          // happening around the same time).
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      };
      // Two workers at a time, staggered — gentle enough not to look like
      // hammering NT's API, even though it now takes a bit longer to
      // finish filling in the Teams tab on first install.
      await Promise.all(Array.from({ length: 2 }, worker));
    }

    async function captureFromPath(pathname) {
      const m = pathname.match(/^\/team\/([^/?#]+)/i);
      if (!m) return null;
      const tag = decodeURIComponent(m[1]).toUpperCase();
      try {
        const team = await NT.fetchTeam(tag);
        await remember(team);
        return team;
      } catch (e) {
        // Not fatal — just don't add it.
        return null;
      }
    }

    load();
    return { remember, mergeRemote, list, unseenCount, markSeen, subscribe, seedOnce, captureFromPath };
  })();

  // Give the page (and anything the user does right away, like opening
  // the panel to run a Compare) a few quiet seconds before this one-time
  // background burst starts, rather than competing with it for NT's API
  // right out of the gate.
  setTimeout(() => TeamDirectory.seedOnce(), 4000);
  SharedTeams.pullAll().then((remote) => TeamDirectory.mergeRemote(remote));

  // ---------------------------------------------------------------------
  // Theme — a couple of alternate accent-color palettes, applied as CSS
  // custom properties on documentElement rather than inside any one shadow
  // root, so the panel and every badge's own separate shadow root (each
  // has its own :host) all pick up the same choice automatically, since
  // custom properties inherit down through the light DOM into shadow
  // trees from an outer ancestor.
  // ---------------------------------------------------------------------

  const THEMES = {
    red: { label: "Nitro Red", red: "#d62f3a", gold: "#f0c75e" },
    gold: { label: "Gold Rush", red: "#e0982a", gold: "#ffe08a" },
    blue: { label: "Blue Steel", red: "#1c99f4", gold: "#8fd4ff" },
    green: { label: "Nitro Green", red: "#2fa84f", gold: "#f0c75e" },
  };
  const Theme = (() => {
    let current = "red";
    const subscribers = [];
    function apply(id) {
      const theme = THEMES[id] || THEMES.red;
      document.documentElement.style.setProperty("--ntcmp-theme-red", theme.red);
      document.documentElement.style.setProperty("--ntcmp-theme-gold", theme.gold);
    }
    async function load() {
      current = (await storageGet("ntcmp:theme")) || "red";
      apply(current);
    }
    function get() {
      return current;
    }
    async function set(id) {
      if (!THEMES[id] || id === current) return;
      current = id;
      apply(id);
      await storageSet({ "ntcmp:theme": id });
      subscribers.forEach((fn) => fn(id));
    }
    function subscribe(fn) {
      subscribers.push(fn);
    }
    load();
    return { get, set, subscribe, THEMES };
  })();

  // ---------------------------------------------------------------------
  // Settings — just "my team" and "my racer", so the on-page comparison
  // badges (below) know what to compare whatever you're looking at
  // against. Nothing here is sent anywhere; it's used purely to build the
  // two NT API calls the badges make.
  // ---------------------------------------------------------------------

  const Settings = (() => {
    let myTeam = "";
    let myRacer = "";
    const subscribers = [];
    let resolveReady;
    const ready = new Promise((resolve) => {
      resolveReady = resolve;
    });

    async function load() {
      myTeam = (await storageGet("ntcmp:myTeam")) || "";
      myRacer = (await storageGet("ntcmp:myRacer")) || "";
      notify();
      resolveReady();
    }
    function notify() {
      subscribers.forEach((fn) => fn({ myTeam, myRacer }));
    }
    function subscribe(fn) {
      subscribers.push(fn);
    }
    function get() {
      return { myTeam, myRacer };
    }
    async function setMyTeam(tag) {
      myTeam = (tag || "").trim().toUpperCase();
      await storageSet({ "ntcmp:myTeam": myTeam });
      notify();
    }
    async function setMyRacer(username) {
      myRacer = (username || "").trim();
      await storageSet({ "ntcmp:myRacer": myRacer });
      notify();
    }

    load();
    // Resolves once the stored values (if any) have actually been read,
    // so auto-detection (below) never races the storage read and clobbers
    // a value the user already set.
    return { get, subscribe, setMyTeam, setMyRacer, ready };
  })();

  // Auto-detect "my team" / "my racer" straight off Nitro Type's own
  // rendered page while logged in — the account-menu's own link to your
  // profile, and the main nav's own link to your team — rather than
  // asking you to type them in. Never touches cookies, tokens, or any
  // session/auth internals; just reads two ordinary <a href> values NT
  // already put on the page for you. Only fills in a value that's still
  // empty, so it never overwrites something you set yourself.
  async function detectIdentity() {
    await Settings.ready;
    const { myTeam, myRacer } = Settings.get();
    if (!myRacer) {
      const racerLink = document.querySelector('.dropdown--account a[href^="/racer/"]');
      const username = racerLink && decodeURIComponent(racerLink.getAttribute("href").replace(/^\/racer\//, ""));
      if (username) Settings.setMyRacer(username);
    }
    if (!myTeam) {
      const teamLink = document.querySelector('nav.nav a[href^="/team/"]');
      const tag = teamLink && decodeURIComponent(teamLink.getAttribute("href").replace(/^\/team\//, ""));
      if (tag) {
        await Settings.setMyTeam(tag);
        // Auto-watch it too, the moment it's first detected — your own
        // team is the one you'd most want a change alert on, and this
        // only ever fires on that first-ever detection (myTeam was empty
        // a moment ago), so unwatching it later yourself always sticks.
        if (!WatchList.has(tag)) WatchList.toggle(tag);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Watch list — a short, explicit "notify me" list the user builds from
  // the Teams tab (the star on each card). The content script just owns
  // the list; background.js (persistent across page loads, unlike this
  // script) is what actually re-checks these on a timer and fires the
  // notification when something changes.
  // ---------------------------------------------------------------------

  const WatchList = (() => {
    const MAX_WATCHED = 10;
    let tags = [];
    const subscribers = [];

    async function load() {
      tags = (await storageGet("ntcmp:watchedTeams")) || [];
      notify();
    }
    function notify() {
      subscribers.forEach((fn) => fn(tags));
    }
    function subscribe(fn) {
      subscribers.push(fn);
    }
    function has(tag) {
      return tags.includes(tag);
    }
    function list() {
      return tags.slice();
    }
    async function toggle(tag) {
      const clean = (tag || "").trim().toUpperCase();
      if (!clean) return;
      const idx = tags.indexOf(clean);
      if (idx >= 0) {
        tags.splice(idx, 1);
      } else {
        if (tags.length >= MAX_WATCHED) return;
        tags.push(clean);
        // Let background.js grab a fresh baseline snapshot right away,
        // rather than waiting for its next scheduled check.
        chrome.runtime.sendMessage({ type: "ntcmp:watchAdded", tag: clean }).catch(() => {});
      }
      await storageSet({ "ntcmp:watchedTeams": tags });
      notify();
    }

    load();
    return { has, list, toggle, subscribe, MAX_WATCHED };
  })();

  // ---------------------------------------------------------------------
  // Rival list — a short list of other racers, built from the "+ Rival"
  // button on the on-page racer comparison badge (see RacerBadge below).
  // Same split as the team watch list: this just owns the list,
  // background.js's alarm is what actually re-checks each one against
  // your own racer and fires a notification the moment the lead flips.
  // ---------------------------------------------------------------------

  const RivalList = (() => {
    const MAX_RIVALS = 8; // doubles as the racer-dashboard watch list, not just rivals
    let rivals = [];
    const subscribers = [];

    async function load() {
      rivals = (await storageGet("ntcmp:rivals")) || [];
      notify();
    }
    function notify() {
      subscribers.forEach((fn) => fn(rivals));
    }
    function subscribe(fn) {
      subscribers.push(fn);
    }
    function has(username) {
      return rivals.some((r) => r.toLowerCase() === (username || "").toLowerCase());
    }
    function list() {
      return rivals.slice();
    }
    async function toggle(username) {
      const clean = (username || "").trim();
      if (!clean) return;
      const idx = rivals.findIndex((r) => r.toLowerCase() === clean.toLowerCase());
      if (idx >= 0) {
        rivals.splice(idx, 1);
      } else {
        if (rivals.length >= MAX_RIVALS) return;
        rivals.push(clean);
        chrome.runtime.sendMessage({ type: "ntcmp:rivalAdded", username: clean }).catch(() => {});
      }
      await storageSet({ "ntcmp:rivals": rivals });
      notify();
    }

    load();
    return { has, list, toggle, subscribe, MAX_RIVALS };
  })();

  // ---------------------------------------------------------------------
  // Progress — a read-mostly view onto the daily snapshots background.js
  // takes of your own racer (races/speed), plus the daily-race-goal and
  // streak it derives from them. Owned by background.js (it's the one
  // that runs reliably on a timer even with no tab open); this just reads
  // the same storage keys back out for the on-page widgets to render.
  // ---------------------------------------------------------------------

  const Progress = (() => {
    const subscribers = [];
    function notify() {
      subscribers.forEach((fn) => fn());
    }
    function subscribe(fn) {
      subscribers.push(fn);
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes["ntcmp:progressSnapshots"] || changes["ntcmp:streakCount"] || changes["ntcmp:dailyGoal"]) {
        notify();
      }
    });

    async function list() {
      return (await storageGet("ntcmp:progressSnapshots")) || [];
    }
    async function getGoal() {
      return (await storageGet("ntcmp:dailyGoal")) || 0;
    }
    async function getStreak() {
      return (await storageGet("ntcmp:streakCount")) || 0;
    }
    async function getBestStreak() {
      return (await storageGet("ntcmp:bestStreak")) || 0;
    }
    async function setGoal(n) {
      const goal = Math.max(0, Math.round(Number(n) || 0));
      await storageSet({ "ntcmp:dailyGoal": goal });
      notify();
    }
    // Delta between the latest snapshot and the oldest one within the
    // last `days` days (falling back to the very first snapshot if
    // there isn't `days` worth of history yet).
    async function deltaSince(days) {
      const snapshots = await list();
      if (snapshots.length < 2) return null;
      const cutoff = Date.now() - days * 86400000;
      const base = snapshots.find((s) => s.ts >= cutoff) || snapshots[0];
      const current = snapshots[snapshots.length - 1];
      if (base === current) return null;
      return {
        races: (current.racesPlayed || 0) - (base.racesPlayed || 0),
        speed: Math.round(((current.avgSpeed || 0) - (base.avgSpeed || 0)) * 10) / 10,
        sinceDays: Math.max(1, Math.round((current.ts - base.ts) / 86400000)),
      };
    }

    return { list, getGoal, getStreak, getBestStreak, setGoal, deltaSince, subscribe };
  })();

  // ---------------------------------------------------------------------
  // Achievements — simple milestone badges computed purely from data the
  // progress tracker already records (lifetime races, avg-speed peak,
  // best streak), rather than anything new background.js needs to track.
  // ---------------------------------------------------------------------

  const RACE_MILESTONES = [100, 500, 1000, 5000, 10000, 25000, 50000];
  const SPEED_MILESTONES = [60, 80, 100, 120, 140, 160, 180, 200];
  const STREAK_MILESTONES = [3, 7, 14, 30, 60, 100];
  const Achievements = (() => {
    function highestReached(value, tiers) {
      let best = null;
      for (const t of tiers) {
        if (value >= t) best = t;
      }
      return best;
    }
    async function summary() {
      const [snapshots, bestStreak] = await Promise.all([Progress.list(), Progress.getBestStreak()]);
      if (!snapshots.length) return null;
      const lifetimeRaces = Math.max(...snapshots.map((s) => s.racesPlayed || 0));
      const peakSpeed = Math.max(...snapshots.map((s) => s.avgSpeed || 0));
      const races = highestReached(lifetimeRaces, RACE_MILESTONES);
      const speed = highestReached(peakSpeed, SPEED_MILESTONES);
      const streak = highestReached(bestStreak, STREAK_MILESTONES);
      if (!races && !speed && !streak) return null;
      return { races, speed, streak, lifetimeRaces, peakSpeed, bestStreak };
    }
    return { summary };
  })();

  // ---------------------------------------------------------------------
  // Captain roster trends — read-only view of the day-over-day per-member
  // snapshots background.js records for your own team. No alarm logic
  // here; this just reads back what was written and diffs it.
  // ---------------------------------------------------------------------

  const RosterTrend = (() => {
    async function forTeam(tag) {
      const all = (await storageGet("ntcmp:rosterSnapshots")) || {};
      return all[tag] || null;
    }
    // delta: races played since the last recorded day (null if no prior
    // snapshot exists yet, e.g. the very first day this team was tracked).
    function deltaFor(snapshot, username) {
      if (!snapshot || !snapshot.prevMembers) return null;
      const prev = snapshot.prevMembers[username];
      const cur = snapshot.curMembers?.[username];
      if (!prev || !cur) return null;
      return cur.played - prev.played;
    }
    return { forTeam, deltaFor };
  })();

  // ---------------------------------------------------------------------
  // Team activity heatmap — buckets the rolling (timestamp, team-wide
  // total races) log background.js records every ~30 minutes into "which
  // hour of the day does this team race most", in the viewer's own local
  // time. Guards against the weekly race-requirement reset (a sudden drop
  // in the running total) by simply skipping any negative delta rather
  // than treating it as negative activity.
  // ---------------------------------------------------------------------

  const TeamActivity = (() => {
    async function hourlyBuckets(tag) {
      const all = (await storageGet("ntcmp:teamActivityLog")) || {};
      const samples = all[tag] || [];
      const buckets = new Array(24).fill(0);
      for (let i = 1; i < samples.length; i++) {
        const delta = samples[i].totalPlayed - samples[i - 1].totalPlayed;
        if (delta <= 0) continue; // weekly reset or no change — not real activity to bucket
        const hour = new Date(samples[i].ts).getHours();
        buckets[hour] += delta;
      }
      const hasData = buckets.some((v) => v > 0);
      return { buckets, hasData, sampleCount: samples.length };
    }
    return { hourlyBuckets };
  })();

  // ---------------------------------------------------------------------
  // Compare history — a lightweight log of past Compare results, so "how
  // did this matchup look a month ago" is answerable without re-running
  // it. Stores a trimmed snapshot (team rosters drop the member list) to
  // keep local storage small; capped at the most recent 20.
  // ---------------------------------------------------------------------

  const CompareHistory = (() => {
    const MAX_ENTRIES = 20;
    let entries = [];
    const subscribers = [];
    async function load() {
      entries = (await storageGet("ntcmp:compareHistory")) || [];
      notify();
    }
    function notify() {
      subscribers.forEach((fn) => fn(entries));
    }
    function subscribe(fn) {
      subscribers.push(fn);
    }
    function trim(mode, data) {
      if (mode === "team") {
        const { members, ...rest } = data;
        return rest;
      }
      return { ...data };
    }
    async function add(mode, a, b) {
      entries = [{ ts: Date.now(), mode, a: trim(mode, a), b: trim(mode, b) }, ...entries].slice(0, MAX_ENTRIES);
      await storageSet({ "ntcmp:compareHistory": entries });
      notify();
    }
    function list() {
      return entries.slice();
    }
    async function clear() {
      entries = [];
      await storageSet({ "ntcmp:compareHistory": entries });
      notify();
    }
    load();
    return { add, list, clear, subscribe };
  })();

  // Manrope — the same clean, squared-but-flowing geometric sans StarTrack
  // itself uses. Self-hosted in the extension (one variable-weight file,
  // rather than pulled from Google Fonts at runtime) so it always loads
  // regardless of nitrotype.com's own CSP. Defined up here (rather than
  // down by buildPanel, where it conceptually belongs) because the
  // on-page comparison badges below need it too, in their own separate
  // Shadow DOM hosts.
  const FONT_FACE_CSS = `
    @font-face {
      font-family: "Manrope";
      font-weight: 200 800;
      font-style: normal;
      src: url("${chrome.runtime.getURL("fonts/Manrope-Variable.ttf")}") format("truetype-variations");
    }
  `;

  function escBadge(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtDiff(n) {
    const r = Math.round((n || 0) * 10) / 10;
    if (r === 0) return "±0";
    return (r > 0 ? "+" : "") + r;
  }
  function diffClass(n) {
    return n > 0 ? "pos" : n < 0 ? "neg" : "zero";
  }

  // Tiny inline-SVG sparkline — no chart library needed for a badge-sized
  // trend line. Values plot left-to-right, oldest to newest.
  function sparklineSvg(values, { width = 220, height = 46, color = "var(--nt-gold)" } = {}) {
    if (!values || values.length < 2) return "";
    const pad = 3;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const stepX = (width - pad * 2) / (values.length - 1);
    const points = values
      .map((v, i) => {
        const x = pad + i * stepX;
        const y = pad + (1 - (v - min) / span) * (height - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    const lastX = pad + (values.length - 1) * stepX;
    const lastY = pad + (1 - (values[values.length - 1] - min) / span) * (height - pad * 2);
    return `
      <svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="none">
        <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2.5" fill="${color}" />
      </svg>`;
  }

  const BADGE_CSS = `
    :host, * { box-sizing: border-box; }
    :host {
      --nt-panel: #13223a; --nt-line: #24395c; --nt-text: #f0f4fa;
      --nt-dim: #8fa3bf; --nt-gold: var(--ntcmp-theme-gold, #f0c75e);
      --nt-font: "Montserrat", "Manrope", "Segoe UI", Roboto, system-ui, sans-serif;
      all: initial;
    }
    .badge {
      position: fixed; z-index: 2147482998; right: 24px; bottom: 192px;
      display: block; width: 236px; text-decoration: none; cursor: pointer;
      background: var(--nt-panel); border: 2px solid var(--nt-gold);
      border-radius: 14px; padding: 14px 16px; color: var(--nt-text);
      font-family: var(--nt-font); box-shadow: 0 6px 20px rgba(0,0,0,0.5);
    }
    .badge:hover { border-color: var(--nt-gold); }
    .badge-rival-btn {
      position: absolute; top: 10px; right: 10px; background: none; border: none;
      color: var(--nt-dim); font-size: 10.5px; font-weight: 700; cursor: pointer; padding: 2px 4px;
      font-family: var(--nt-font);
    }
    .badge-rival-btn:hover { color: var(--nt-gold); }
    .badge-head { font-weight: 800; font-size: 14px; margin-bottom: 4px; padding-right: 56px; }
    .badge-verdict { color: var(--nt-gold); font-size: 12px; font-weight: 700; margin-bottom: 8px; }
    .badge-row { display: flex; justify-content: space-between; font-size: 12px; color: var(--nt-dim); padding: 2px 0; }
    .badge-row b { color: var(--nt-text); font-weight: 700; }
    .badge-row .diff.pos { color: #6fcf6f; }
    .badge-row .diff.neg { color: #ff7a6e; }
    .badge-row .diff.zero { color: var(--nt-dim); }
    .badge-foot { margin-top: 8px; font-size: 11px; color: var(--nt-gold); font-weight: 700; }
    .badge-foot-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
    .badge-foot-row .badge-foot { margin-top: 0; }
    .badge-export-btn {
      background: none; border: 1px solid var(--nt-gold); color: var(--nt-gold); border-radius: 999px;
      padding: 2px 8px; font-size: 10px; font-weight: 700; cursor: pointer; font-family: var(--nt-font);
    }
    .badge-export-btn:hover { background: var(--nt-gold); color: #13223a; }
    .badge-chart { margin-top: 8px; }
    .badge-chart .spark { display: block; width: 100%; height: 40px; }
    .badge-chart-label { font-size: 10px; color: var(--nt-dim); text-align: center; margin-top: 2px; }
    .badge-milestones { flex-wrap: wrap; justify-content: flex-start; gap: 6px; margin-top: 8px; }
    .badge-milestones span {
      background: var(--nt-bg, #0b1626); border: 1px solid var(--nt-gold); color: var(--nt-gold);
      border-radius: 999px; padding: 3px 8px; font-size: 10.5px; font-weight: 700;
    }
  `;

  // ---------------------------------------------------------------------
  // Team-page comparison badge — on any team's own nitrotype.com page
  // (not your own), shows how it stacks up against the team you've set
  // as "mine" in Settings, with a click-through into a full Compare. Only
  // appears once "my team" is actually set.
  // ---------------------------------------------------------------------

  const TeamBadge = (() => {
    let host = null;
    let root = null;
    let myTeamCache = null; // { tag, data, fetchedAt }

    function ensureHost() {
      if (host) return root;
      host = document.createElement("div");
      host.id = "ntcmp-team-badge-host";
      host.style.all = "initial";
      document.body.appendChild(host);
      root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${FONT_FACE_CSS}${BADGE_CSS}</style><a class="badge" id="badge" href="#" hidden></a>`;
      return root;
    }

    async function getMyTeam(tag) {
      if (myTeamCache && myTeamCache.tag === tag && Date.now() - myTeamCache.fetchedAt < 5 * 60 * 1000) {
        return myTeamCache.data;
      }
      const data = await NT.fetchTeam(tag);
      myTeamCache = { tag, data, fetchedAt: Date.now() };
      return data;
    }

    async function show(viewedTeam) {
      const { myTeam } = Settings.get();
      const r = ensureHost();
      const badge = r.getElementById("badge");
      if (!myTeam || myTeam === viewedTeam.tag) {
        badge.hidden = true;
        return;
      }
      let mine;
      try {
        mine = await getMyTeam(myTeam);
      } catch (e) {
        badge.hidden = true;
        return;
      }
      const diffMembers = (viewedTeam.memberCount ?? 0) - (mine.memberCount ?? 0);
      const theirSpeed = viewedTeam.info?.minSpeed ?? 0;
      const mySpeed = mine.info?.minSpeed ?? 0;
      const theirRaces = viewedTeam.trend?.minRaces ?? 0;
      const myRaces = mine.trend?.minRaces ?? 0;
      const diffSpeed = theirSpeed - mySpeed;
      const diffRaces = theirRaces - myRaces;
      const verdict =
        diffSpeed <= 0 && diffRaces <= 0 && (diffSpeed < 0 || diffRaces < 0)
          ? "Lower requirements than yours"
          : diffSpeed >= 0 && diffRaces >= 0 && (diffSpeed > 0 || diffRaces > 0)
          ? "Higher requirements than yours"
          : "Even with yours";
      badge.innerHTML = `
        <div class="badge-head">[${escBadge(viewedTeam.tag)}] vs your [${escBadge(mine.tag)}]</div>
        <div class="badge-verdict">${verdict}</div>
        <div class="badge-row">Members <span><b>${viewedTeam.memberCount ?? "—"}</b> <span class="diff ${diffClass(diffMembers)}">${fmtDiff(diffMembers)}</span></span></div>
        <div class="badge-row">Min speed <span><b>${theirSpeed}</b> <span class="diff ${diffClass(diffSpeed)}">${fmtDiff(diffSpeed)}</span></span></div>
        <div class="badge-row">Min races <span><b>${theirRaces}</b> <span class="diff ${diffClass(diffRaces)}">${fmtDiff(diffRaces)}</span></span></div>
        <div class="badge-foot">Click to open full Compare</div>`;
      badge.hidden = false;
      badge.onclick = (e) => {
        e.preventDefault();
        if (panelApi) {
          panelApi.open();
          panelApi.compareTeams(mine.tag, viewedTeam.tag);
        }
      };
    }

    function hide() {
      if (root) root.getElementById("badge").hidden = true;
    }

    return { show, hide };
  })();

  // ---------------------------------------------------------------------
  // Racer-page comparison badge — same idea, on a racer's own profile
  // page, against the racer you've set as "mine" in Settings.
  // ---------------------------------------------------------------------

  const RacerBadge = (() => {
    let host = null;
    let root = null;
    let myRacerCache = null; // { username, data, fetchedAt }

    function ensureHost() {
      if (host) return root;
      host = document.createElement("div");
      host.id = "ntcmp-racer-badge-host";
      host.style.all = "initial";
      document.body.appendChild(host);
      root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${FONT_FACE_CSS}${BADGE_CSS}</style><a class="badge" id="badge" href="#" hidden></a>`;
      return root;
    }

    async function getMyRacer(username) {
      if (myRacerCache && myRacerCache.username.toLowerCase() === username.toLowerCase() && Date.now() - myRacerCache.fetchedAt < 5 * 60 * 1000) {
        return myRacerCache.data;
      }
      const data = await NT.fetchRacer(username);
      myRacerCache = { username, data, fetchedAt: Date.now() };
      return data;
    }

    async function showForUsername(username) {
      const { myRacer } = Settings.get();
      const r = ensureHost();
      const badge = r.getElementById("badge");
      if (!myRacer || myRacer.toLowerCase() === username.toLowerCase()) {
        badge.hidden = true;
        return;
      }
      let mine, theirs;
      try {
        [mine, theirs] = await Promise.all([getMyRacer(myRacer), NT.fetchRacer(username)]);
      } catch (e) {
        badge.hidden = true;
        return;
      }
      const diffAvg = (theirs.avgSpeed ?? 0) - (mine.avgSpeed ?? 0);
      const diffTop = (theirs.highestSpeed ?? 0) - (mine.highestSpeed ?? 0);
      const diffRaces = (theirs.racesPlayed ?? 0) - (mine.racesPlayed ?? 0);
      const verdict = diffAvg > 0 ? "Faster than you on average" : diffAvg < 0 ? "Slower than you on average" : "Even with you on average";
      const isRival = RivalList.has(theirs.username);
      badge.innerHTML = `
        <button type="button" class="badge-rival-btn" id="rival-btn">${isRival ? "★ Rival" : "☆ Add rival"}</button>
        <div class="badge-head">${escBadge(theirs.displayName)} vs you</div>
        <div class="badge-verdict">${verdict}</div>
        <div class="badge-row">Avg speed <span><b>${theirs.avgSpeed ?? 0}</b> <span class="diff ${diffClass(diffAvg)}">${fmtDiff(diffAvg)}</span></span></div>
        <div class="badge-row">Top speed <span><b>${theirs.highestSpeed ?? 0}</b> <span class="diff ${diffClass(diffTop)}">${fmtDiff(diffTop)}</span></span></div>
        <div class="badge-row">Lifetime races <span><b>${theirs.racesPlayed ?? 0}</b> <span class="diff ${diffClass(diffRaces)}">${fmtDiff(diffRaces)}</span></span></div>
        <div class="badge-foot">Click to open full Compare</div>`;
      badge.hidden = false;
      badge.onclick = (e) => {
        e.preventDefault();
        if (panelApi) {
          panelApi.open();
          panelApi.compareRacers(mine.username, theirs.username);
        }
      };
      r.getElementById("rival-btn").onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        RivalList.toggle(theirs.username).then(() => showForUsername(username));
      };
    }

    function hide() {
      if (root) root.getElementById("badge").hidden = true;
    }

    return { showForUsername, hide };
  })();

  // ---------------------------------------------------------------------
  // Your-own-progress badge — shown instead of RacerBadge when the racer
  // page you're looking at is your own. Reads the daily snapshots
  // background.js has been quietly taking (see Progress above) and shows
  // real deltas, since NT's own racer page no longer has any recent-form
  // view at all.
  // ---------------------------------------------------------------------

  const ProgressBadge = (() => {
    let host = null;
    let root = null;

    function ensureHost() {
      if (host) return root;
      host = document.createElement("div");
      host.id = "ntcmp-progress-badge-host";
      host.style.all = "initial";
      document.body.appendChild(host);
      root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${FONT_FACE_CSS}${BADGE_CSS}</style><div class="badge" id="badge" hidden></div>`;
      return root;
    }

    async function show() {
      const r = ensureHost();
      const badge = r.getElementById("badge");
      const [delta, goal, streak, snapshots] = await Promise.all([
        Progress.deltaSince(7),
        Progress.getGoal(),
        Progress.getStreak(),
        Progress.list(),
      ]);
      if (!delta && !goal) {
        // Nothing recorded yet (first visit since this build, or no
        // history at all) — stay out of the way rather than show an
        // empty-looking card.
        badge.hidden = true;
        return;
      }
      const deltaLine = delta
        ? `<div class="badge-row">Last ${delta.sinceDays}d <span><b>${fmtDiff(delta.races)}</b> races <span class="diff ${diffClass(delta.speed)}">${fmtDiff(delta.speed)}</span> wpm</span></div>`
        : `<div class="badge-row">Tracking started today — check back tomorrow for a trend.</div>`;
      const goalLine = goal
        ? `<div class="badge-row">Daily goal <span><b>${goal}</b> races${streak > 0 ? ` · 🔥 ${streak}-day streak` : ""}</span></div>`
        : "";
      const verdict = !delta ? "Just started tracking" : delta.races > 0 ? "Trending up" : delta.races < 0 ? "Slower lately" : "Holding steady";
      const speeds = (snapshots || []).slice(-21).map((s) => s.avgSpeed || 0);
      const chart = sparklineSvg(speeds);
      const chartBlock = chart ? `<div class="badge-chart">${chart}<div class="badge-chart-label">Avg speed, last ${speeds.length} snapshots</div></div>` : "";
      const achievements = await Achievements.summary();
      const milestoneLine = achievements
        ? `<div class="badge-row badge-milestones">
             ${achievements.races ? `<span title="${achievements.lifetimeRaces.toLocaleString()} lifetime races">🏁 ${achievements.races.toLocaleString()}+</span>` : ""}
             ${achievements.speed ? `<span title="Peak avg speed seen: ${achievements.peakSpeed} wpm">⚡ ${achievements.speed}+ wpm</span>` : ""}
             ${achievements.streak ? `<span title="Best daily-goal streak: ${achievements.bestStreak} days">🔥 ${achievements.streak}+ day streak</span>` : ""}
           </div>`
        : "";
      badge.innerHTML = `
        <div class="badge-head">Your progress</div>
        <div class="badge-verdict">${verdict}</div>
        ${deltaLine}
        ${goalLine}
        ${chartBlock}
        ${milestoneLine}
        <div class="badge-foot-row">
          <span class="badge-foot">Recorded automatically in the background</span>
          <button type="button" class="badge-export-btn" id="progress-export-btn" title="Download your snapshot history as a CSV">⤓ CSV</button>
        </div>`;
      badge.hidden = false;
      const exportBtn = r.getElementById("progress-export-btn");
      if (exportBtn) {
        exportBtn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const rows = [["Date", "Lifetime races", "Avg speed", "Top speed"]];
          (snapshots || []).forEach((s) => rows.push([new Date(s.ts).toISOString().slice(0, 10), s.racesPlayed ?? "", s.avgSpeed ?? "", s.highestSpeed ?? ""]));
          const csv = rows.map((row) => row.join(",")).join("\n");
          const blob = new Blob([csv], { type: "text/csv" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `typetrack-progress-${Date.now()}.csv`;
          a.click();
          URL.revokeObjectURL(url);
        };
      }
    }

    function hide() {
      if (root) root.getElementById("badge").hidden = true;
    }

    return { show, hide };
  })();

  // ---------------------------------------------------------------------
  // Roster compliance badge — shown instead of TeamBadge when the team
  // page you're looking at is your own. Flags members under the team's
  // own min-race requirement, straight from the roster data NT.fetchTeam()
  // already pulled in — the thing a captain actually checks before
  // kicking someone.
  // ---------------------------------------------------------------------

  const RosterBadge = (() => {
    let host = null;
    let root = null;

    function ensureHost() {
      if (host) return root;
      host = document.createElement("div");
      host.id = "ntcmp-roster-badge-host";
      host.style.all = "initial";
      document.body.appendChild(host);
      root = host.attachShadow({ mode: "open" });
      root.innerHTML = `
        <style>
          ${FONT_FACE_CSS}${BADGE_CSS}
          .roster-list { margin: 8px 0 0; padding: 0; list-style: none; max-height: 160px; overflow-y: auto; }
          .roster-list li { display: flex; justify-content: space-between; gap: 8px; font-size: 11.5px; color: var(--nt-dim); padding: 2px 0; }
          .roster-list b { color: var(--nt-text); }
        </style>
        <div class="badge" id="badge" hidden></div>`;
      return root;
    }

    function show(team) {
      const r = ensureHost();
      const badge = r.getElementById("badge");
      const minRaces = team.trend?.minRaces ?? team.info?.minRaces ?? 0;
      const total = team.memberCount ?? team.members?.length ?? 0;
      if (!minRaces) {
        badge.hidden = true;
        return;
      }
      const below = (team.members || [])
        .filter((m) => (m.played || 0) < minRaces)
        .sort((a, b) => (a.played || 0) - (b.played || 0));
      if (!below.length) {
        badge.innerHTML = `
          <div class="badge-head">[${escBadge(team.tag)}] roster</div>
          <div class="badge-verdict">Everyone's meeting the ${minRaces}-race requirement</div>
          <div class="badge-foot">${total} members checked</div>`;
        badge.hidden = false;
        return;
      }
      const rows = below
        .slice(0, 8)
        .map((m) => `<li>${escBadge(m.displayName || m.username || "—")} <b>${m.played ?? 0}/${minRaces}</b></li>`)
        .join("");
      badge.innerHTML = `
        <div class="badge-head">[${escBadge(team.tag)}] roster</div>
        <div class="badge-verdict">${below.length} of ${total} below the ${minRaces}-race requirement</div>
        <ul class="roster-list">${rows}</ul>
        ${below.length > 8 ? `<div class="badge-foot">+${below.length - 8} more below requirement</div>` : ""}`;
      badge.hidden = false;
    }

    function hide() {
      if (root) root.getElementById("badge").hidden = true;
    }

    return { show, hide };
  })();

  // ---------------------------------------------------------------------
  // Nav tab injection (clones a real nav <li> so it inherits NT's own
  // styling exactly, rather than us guessing their class names) — and,
  // piggybacking on the same poll, passive team-page capture above.
  // ---------------------------------------------------------------------

  function ensureNavTab() {
    if (document.getElementById(NAV_TAB_ID)) return;
    // Scoped to the real top nav specifically — Nitro Type's page now also
    // has a second, hidden "/leaderboards" link inside an account dropdown
    // earlier in the DOM, and an unscoped selector was matching that one
    // instead, so the cloned tab inherited that dropdown's
    // `visibility: hidden` and was invisible even though it existed.
    const anchor = document.querySelector('nav.nav a[href="/leaderboards"]');
    const li = anchor && anchor.closest("li");
    if (!li || !li.parentNode) return;

    const clone = li.cloneNode(true);
    clone.id = NAV_TAB_ID;
    clone.style.position = "relative";
    const link = clone.querySelector("a") || clone;
    link.removeAttribute("href");
    link.style.cursor = "pointer";
    link.setAttribute("role", "button");
    // Keep whatever wrapper markup NT uses, just swap the visible label —
    // plain text, no emoji — plus a notification dot, so the unseen-teams
    // signal (see updateNavBadge below) has somewhere to live without us
    // having to re-clone or re-style NT's own nav markup.
    const labelNode = link.querySelector("span") || link;
    labelNode.textContent = "";
    labelNode.append("TypeTrack");
    // A plain notification dot — top-left corner of the whole tab, not a
    // numbered badge — shown only when there's something new to notice
    // (an unseen team, or a version update not yet opened).
    const badge = document.createElement("span");
    badge.id = "ntcmp-nav-badge";
    badge.style.cssText =
      "position:absolute;top:2px;left:2px;width:8px;height:8px;border-radius:50%;background:#e0393f;";
    badge.hidden = true;
    clone.appendChild(badge);
    link.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (panelApi) panelApi.toggle();
    });

    li.parentNode.insertBefore(clone, li.nextSibling);
    refreshNavBadge();
  }

  // The notification dot combines two independent "something's new"
  // signals: an unseen team (local find or shared-list sync) and a
  // version update the person hasn't opened the panel since. Either one
  // on its own is enough to show it; neither shows a count — the dot is
  // purely a "look here" signal, not a number.
  const CURRENT_VERSION = chrome.runtime.getManifest().version;
  async function isUnseenVersion() {
    const stored = await storageGet("ntcmp:lastSeenVersion");
    // No stored version yet means this is the very first run ever seen —
    // nothing to "catch up on", so set today's version as the baseline
    // quietly rather than flagging day-one as a change.
    if (stored == null) {
      await storageSet({ "ntcmp:lastSeenVersion": CURRENT_VERSION });
      return false;
    }
    return stored !== CURRENT_VERSION;
  }
  async function markVersionSeen() {
    await storageSet({ "ntcmp:lastSeenVersion": CURRENT_VERSION });
  }
  async function refreshNavBadge() {
    const badge = document.getElementById("ntcmp-nav-badge");
    if (!badge) return;
    const [unseenTeams, unseenVersion] = await Promise.all([TeamDirectory.unseenCount(), isUnseenVersion()]);
    badge.hidden = !(unseenTeams > 0 || unseenVersion);
  }
  TeamDirectory.subscribe(() => refreshNavBadge());

  let lastCapturedPath = null;
  function onPossibleNavigation() {
    ensureNavTab();
    detectIdentity();
    if (location.pathname !== lastCapturedPath) {
      lastCapturedPath = location.pathname;
      const teamMatch = location.pathname.match(/^\/team\/([^/?#]+)/i);
      const racerMatch = location.pathname.match(/^\/racer\/([^/?#]+)/i);
      if (teamMatch) {
        RacerBadge.hide();
        ProgressBadge.hide();
        TeamDirectory.captureFromPath(location.pathname).then(async (team) => {
          if (!team) {
            TeamBadge.hide();
            RosterBadge.hide();
            return;
          }
          // Wait for Settings to actually finish loading before deciding
          // whether this is "my team" — otherwise a very fast first page
          // load could momentarily read myTeam as empty and show the
          // wrong (or no) badge.
          await Settings.ready;
          const { myTeam } = Settings.get();
          if (myTeam && myTeam === team.tag) {
            TeamBadge.hide();
            RosterBadge.show(team);
          } else {
            RosterBadge.hide();
            TeamBadge.show(team);
          }
        });
      } else if (racerMatch) {
        TeamBadge.hide();
        RosterBadge.hide();
        const username = decodeURIComponent(racerMatch[1]);
        Settings.ready.then(() => {
          const { myRacer } = Settings.get();
          if (myRacer && myRacer.toLowerCase() === username.toLowerCase()) {
            RacerBadge.hide();
            ProgressBadge.show();
          } else {
            ProgressBadge.hide();
            RacerBadge.showForUsername(username);
          }
        });
      } else {
        TeamBadge.hide();
        RacerBadge.hide();
        RosterBadge.hide();
        ProgressBadge.hide();
      }
    }
  }

  const navObserver = new MutationObserver(() => onPossibleNavigation());
  navObserver.observe(document.documentElement, { childList: true, subtree: true });
  onPossibleNavigation();
  setInterval(onPossibleNavigation, 2000); // cheap safety net for SPA re-renders the observer might miss

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "ntcmp:toggle" && panelApi) panelApi.toggle();
  });

  // ---------------------------------------------------------------------
  // Panel (Shadow DOM — fully isolated styling in both directions)
  // ---------------------------------------------------------------------

  function buildPanel() {
    const host = document.createElement("div");
    host.id = "ntcmp-host";
    host.style.all = "initial";
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });

    root.innerHTML = `
      <style>${FONT_FACE_CSS}${PANEL_CSS}</style>
      <div class="backdrop" id="backdrop"></div>
      <div class="panel" id="panel">
        <header class="head">
          <div class="head-top">
            <span class="logo"><span class="logo-bolt">⚡</span>TYPETRACK</span>
            <div class="head-top-actions">
              <div class="settings-wrap">
                <button class="gear-btn" id="gear-btn" aria-label="Settings" title="Set your team &amp; racer">⚙</button>
                <div class="settings-pop" id="settings-pop" hidden>
                  <div class="settings-title">Your identity</div>
                  <div class="settings-note">Auto-filled from your Nitro Type account when you're logged in — change either one any time, and it sticks.</div>
                  <label class="settings-field">
                    <span>My team tag</span>
                    <input type="text" id="settings-my-team" placeholder="e.g. IMT" autocomplete="off" spellcheck="false" />
                  </label>
                  <label class="settings-field">
                    <span>My racer username</span>
                    <input type="text" id="settings-my-racer" placeholder="e.g. voidracer" autocomplete="off" spellcheck="false" />
                  </label>
                  <label class="settings-field">
                    <span>Daily race goal (optional)</span>
                    <input type="number" id="settings-daily-goal" min="0" placeholder="e.g. 50" autocomplete="off" />
                  </label>
                  <div class="settings-field">
                    <span>Theme</span>
                    <div class="theme-swatches" id="theme-swatches"></div>
                  </div>
                  <button type="button" class="settings-invite-btn" id="settings-invite-btn">📋 Share TypeTrack</button>
                  <button type="button" class="settings-save" id="settings-save">Save</button>
                </div>
              </div>
              <button class="close-btn" id="close-btn" aria-label="Close">✕</button>
            </div>
          </div>
          <div class="head-tabs">
            <div class="mode-switch view-switch">
              <button class="mode-btn view-btn active" data-view="compare" type="button"><span class="tab-icon">⇄</span>Compare</button>
              <button class="mode-btn view-btn" data-view="teams" type="button"><span class="tab-icon">▦</span>Teams</button>
              <button class="mode-btn view-btn" data-view="racers" type="button"><span class="tab-icon">◎</span>Racers</button>
              <button class="mode-btn view-btn" data-view="today" type="button"><span class="tab-icon">◷</span>Today</button>
              <button class="mode-btn view-btn" data-view="leaderboard" type="button"><span class="tab-icon">🏆</span>Leaderboard</button>
            </div>
            <div class="head-tabs-actions">
              <button type="button" class="my-team-btn" id="my-team-btn" title="Open your team's roster" hidden>My Team</button>
              <a class="race-now-btn" id="race-now-btn" href="https://www.nitrotype.com/race">🏁 Race Now</a>
            </div>
          </div>
        </header>

        <div class="content">
          <div id="view-compare" class="view">
            <div class="compare-inner">
              <div class="mode-switch">
                <button class="mode-btn active" data-mode="team" type="button">Teams</button>
                <button class="mode-btn" data-mode="racer" type="button">Racers</button>
              </div>
              <form id="compare-form" class="inputs">
                <label class="field">
                  <span class="field-label" id="label-a">Team A tag</span>
                  <input type="text" id="input-a" list="known-teams" autocomplete="off" spellcheck="false" />
                  <button type="button" class="find-link" id="find-a" hidden>Find by name</button>
                </label>
                <span class="vs">VS</span>
                <label class="field">
                  <span class="field-label" id="label-b">Team B tag</span>
                  <input type="text" id="input-b" list="known-teams" autocomplete="off" spellcheck="false" />
                  <button type="button" class="find-link" id="find-b" hidden>Find by name</button>
                </label>
                <button type="submit" class="compare-btn">Compare</button>
              </form>
              <datalist id="known-teams"></datalist>
              <button type="button" class="history-toggle" id="history-toggle">Recent comparisons</button>
              <div id="compare-history" class="compare-history" hidden></div>

              <div id="finder-a" class="finder" hidden>
                <div class="finder-row">
                  <input type="text" class="finder-team-input" list="known-teams" placeholder="Team tag, e.g. IMT" autocomplete="off" spellcheck="false" />
                  <button type="button" class="finder-load-btn">Load roster</button>
                </div>
                <select class="finder-roster" hidden></select>
                <div class="finder-status"></div>
              </div>
              <div id="finder-b" class="finder" hidden>
                <div class="finder-row">
                  <input type="text" class="finder-team-input" list="known-teams" placeholder="Team tag, e.g. IMT" autocomplete="off" spellcheck="false" />
                  <button type="button" class="finder-load-btn">Load roster</button>
                </div>
                <select class="finder-roster" hidden></select>
                <div class="finder-status"></div>
              </div>

              <div id="status" class="status" hidden></div>
              <button type="button" id="export-csv-btn" class="history-toggle" hidden>Export as CSV</button>
              <div id="result" class="result" hidden></div>
            </div>
          </div>

          <div id="view-teams" class="view" hidden>
            <div class="teams-head">
              <div class="teams-heading">
                <h2 class="teams-title">Browse teams</h2>
                <div class="teams-count" id="teams-count">0 teams tracked</div>
              </div>
              <div class="teams-head-actions">
                <input type="text" id="teams-search" class="teams-search" placeholder="Search teams…" autocomplete="off" spellcheck="false" />
                <button type="button" id="team-finder-btn" class="team-finder-btn" title="Rank tracked teams against your own avg speed">Find teams for me</button>
                <button type="button" id="team-leaderboard-btn" class="team-finder-btn" title="Rank the teams currently shown by their real race performance">🏆 Leaderboard</button>
              </div>
            </div>
            <div id="team-finder-note" class="team-finder-note" hidden></div>
            <div id="team-leaderboard-note" class="team-finder-note" hidden></div>
            <div class="teams-filters">
              <label class="teams-filter">
                <span>Sort</span>
                <select id="teams-sort">
                  <option value="tag">Tag (A–Z)</option>
                  <option value="members-desc">Most members</option>
                  <option value="members-asc">Fewest members</option>
                  <option value="formed-desc">Newest</option>
                  <option value="formed-asc">Oldest</option>
                  <option value="speed-asc">Lowest speed req</option>
                  <option value="speed-desc">Highest speed req</option>
                </select>
              </label>
              <label class="teams-filter">
                <span>Max min speed</span>
                <input type="number" id="teams-max-speed" min="0" placeholder="Any" />
              </label>
              <label class="teams-filter">
                <span>Max min races</span>
                <input type="number" id="teams-max-races" min="0" placeholder="Any" />
              </label>
              <label class="teams-filter">
                <span>Min members</span>
                <input type="number" id="teams-min-members" min="0" placeholder="Any" />
              </label>
              <button type="button" id="teams-filters-clear" class="teams-filters-clear">Clear filters</button>
            </div>
            <div class="teams-grid" id="teams-list"></div>
          </div>

          <div id="view-team-detail" class="view" hidden>
            <button type="button" class="team-detail-back" id="team-detail-back">← Back to teams</button>
            <div id="team-detail-body" class="team-detail-body">
              <div class="teams-empty">Loading roster…</div>
            </div>
          </div>

          <div id="view-racers" class="view" hidden>
            <div class="teams-head">
              <div class="teams-heading">
                <h2 class="teams-title">Racer dashboard</h2>
                <div class="teams-count" id="racers-count">0 racers tracked</div>
              </div>
              <div class="teams-head-actions">
                <input type="text" id="racer-dash-input" class="teams-search" placeholder="Add a racer username…" autocomplete="off" spellcheck="false" />
                <button type="button" id="racer-dash-add" class="team-finder-btn">Add</button>
                <button type="button" id="racer-dash-refresh" class="team-finder-btn">Refresh</button>
              </div>
            </div>
            <label class="teams-filter racer-dash-sort-field">
              <span>Sort</span>
              <select id="racer-dash-sort">
                <option value="added">Order added</option>
                <option value="speed">Avg speed</option>
                <option value="top">Top speed</option>
                <option value="races">Lifetime races</option>
              </select>
            </label>
            <div id="racers-dash-list" class="racers-dash-list"></div>
          </div>

          <div id="view-leaderboard" class="view" hidden>
            <div class="teams-head">
              <div class="teams-heading">
                <h2 class="teams-title">All-Time Racer Leaderboard</h2>
                <div class="teams-count" id="leaderboard-count">0 racers ranked</div>
              </div>
              <div class="teams-head-actions">
                <button type="button" id="leaderboard-build-btn" class="team-finder-btn">🔄 Build / Rebuild</button>
              </div>
            </div>
            <div id="leaderboard-note" class="team-finder-note" hidden></div>
            <div id="leaderboard-list" class="racers-dash-list"></div>
            <div id="leaderboard-pagination" class="racer-leaderboard-pagination" hidden>
              <button type="button" id="leaderboard-prev" class="team-finder-btn">← Prev</button>
              <span id="leaderboard-page-label"></span>
              <button type="button" id="leaderboard-next" class="team-finder-btn">Next →</button>
            </div>
          </div>

          <div id="view-today" class="view" hidden>
            <div class="teams-head">
              <div class="teams-heading">
                <h2 class="teams-title">Today</h2>
              </div>
            </div>
            <div id="today-body" class="team-detail-body">
              <div class="teams-empty">Loading…</div>
            </div>
          </div>
        </div>
      </div>`;

    return { host, root };
  }

  function wirePanel(root) {
    const state = { mode: "team", open: false };

    const els = {
      backdrop: root.getElementById("backdrop"),
      panel: root.getElementById("panel"),
      gearBtn: root.getElementById("gear-btn"),
      raceNowBtn: root.getElementById("race-now-btn"),
      myTeamBtn: root.getElementById("my-team-btn"),
      settingsPop: root.getElementById("settings-pop"),
      settingsMyTeam: root.getElementById("settings-my-team"),
      settingsMyRacer: root.getElementById("settings-my-racer"),
      settingsDailyGoal: root.getElementById("settings-daily-goal"),
      themeSwatches: root.getElementById("theme-swatches"),
      settingsSave: root.getElementById("settings-save"),
      closeBtn: root.getElementById("close-btn"),
      viewBtns: root.querySelectorAll(".view-btn"),
      viewCompare: root.getElementById("view-compare"),
      viewTeams: root.getElementById("view-teams"),
      modeBtns: root.querySelectorAll(".mode-btn:not(.view-btn)"),
      labelA: root.getElementById("label-a"),
      labelB: root.getElementById("label-b"),
      inputA: root.getElementById("input-a"),
      inputB: root.getElementById("input-b"),
      findA: root.getElementById("find-a"),
      findB: root.getElementById("find-b"),
      finderA: root.getElementById("finder-a"),
      finderB: root.getElementById("finder-b"),
      teamsSearch: root.getElementById("teams-search"),
      teamFinderBtn: root.getElementById("team-finder-btn"),
      teamFinderNote: root.getElementById("team-finder-note"),
      teamLeaderboardBtn: root.getElementById("team-leaderboard-btn"),
      teamLeaderboardNote: root.getElementById("team-leaderboard-note"),
      teamsSort: root.getElementById("teams-sort"),
      teamsMaxSpeed: root.getElementById("teams-max-speed"),
      teamsMaxRaces: root.getElementById("teams-max-races"),
      teamsMinMembers: root.getElementById("teams-min-members"),
      teamsFiltersClear: root.getElementById("teams-filters-clear"),
      teamsList: root.getElementById("teams-list"),
      viewTeamDetail: root.getElementById("view-team-detail"),
      teamDetailBack: root.getElementById("team-detail-back"),
      teamDetailBody: root.getElementById("team-detail-body"),
      viewRacers: root.getElementById("view-racers"),
      racersCount: root.getElementById("racers-count"),
      racerDashInput: root.getElementById("racer-dash-input"),
      racerDashAdd: root.getElementById("racer-dash-add"),
      racerDashRefresh: root.getElementById("racer-dash-refresh"),
      racerDashSort: root.getElementById("racer-dash-sort"),
      viewLeaderboard: root.getElementById("view-leaderboard"),
      leaderboardCount: root.getElementById("leaderboard-count"),
      leaderboardBuildBtn: root.getElementById("leaderboard-build-btn"),
      leaderboardNote: root.getElementById("leaderboard-note"),
      leaderboardList: root.getElementById("leaderboard-list"),
      leaderboardPagination: root.getElementById("leaderboard-pagination"),
      leaderboardPrev: root.getElementById("leaderboard-prev"),
      leaderboardNext: root.getElementById("leaderboard-next"),
      leaderboardPageLabel: root.getElementById("leaderboard-page-label"),
      racersDashList: root.getElementById("racers-dash-list"),
      viewToday: root.getElementById("view-today"),
      todayBody: root.getElementById("today-body"),
      settingsInviteBtn: root.getElementById("settings-invite-btn"),
      teamsCount: root.getElementById("teams-count"),
      knownTeamsList: root.getElementById("known-teams"),
      form: root.getElementById("compare-form"),
      historyToggle: root.getElementById("history-toggle"),
      compareHistory: root.getElementById("compare-history"),
      btn: root.querySelector(".compare-btn"),
      status: root.getElementById("status"),
      exportCsvBtn: root.getElementById("export-csv-btn"),
      result: root.getElementById("result"),
    };

    // Settings popover (gear icon) — "my team" / "my racer", feeding the
    // on-page comparison badges.
    els.gearBtn.addEventListener("click", async () => {
      const opening = els.settingsPop.hidden;
      els.settingsPop.hidden = !els.settingsPop.hidden;
      if (opening) els.settingsDailyGoal.value = (await Progress.getGoal()) || "";
    });
    function fillSettingsInputs({ myTeam, myRacer }) {
      els.settingsMyTeam.value = myTeam || "";
      els.settingsMyRacer.value = myRacer || "";
      els.myTeamBtn.hidden = !myTeam;
    }
    fillSettingsInputs(Settings.get());
    Settings.subscribe(fillSettingsInputs);
    els.myTeamBtn.addEventListener("click", () => {
      const { myTeam } = Settings.get();
      if (myTeam) openTeamDetail(myTeam);
    });
    els.settingsSave.addEventListener("click", async () => {
      await Settings.setMyTeam(els.settingsMyTeam.value);
      await Settings.setMyRacer(els.settingsMyRacer.value);
      await Progress.setGoal(els.settingsDailyGoal.value);
      els.settingsPop.hidden = true;
    });

    function renderThemeSwatches() {
      const active = Theme.get();
      els.themeSwatches.innerHTML = Object.entries(Theme.THEMES)
        .map(
          ([id, t]) => `
          <button type="button" class="theme-swatch${id === active ? " active" : ""}" data-id="${id}" title="${escapeHtml(t.label)}"
            style="--swatch-red:${t.red};--swatch-gold:${t.gold}"></button>`
        )
        .join("");
    }
    renderThemeSwatches();
    els.themeSwatches.addEventListener("click", (e) => {
      const btn = e.target.closest(".theme-swatch");
      if (!btn) return;
      Theme.set(btn.dataset.id).then(renderThemeSwatches);
    });


    function renderKnownTeamsDatalist(teams) {
      els.knownTeamsList.innerHTML = teams
        .map((t) => `<option value="${t.tag}">${t.tag} — ${escapeHtml(t.name)}</option>`)
        .join("");
    }
    TeamDirectory.subscribe(renderKnownTeamsDatalist);

    function escapeHtml(s) {
      return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    function setMode(mode) {
      state.mode = mode;
      els.modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
      const isTeam = mode === "team";
      els.labelA.textContent = isTeam ? "Team A tag" : "Racer A username";
      els.labelB.textContent = isTeam ? "Team B tag" : "Racer B username";
      els.inputA.placeholder = isTeam ? "e.g. IMT" : "e.g. voidracer";
      els.inputB.placeholder = isTeam ? "e.g. KU" : "e.g. speedking";
      els.findA.hidden = isTeam;
      els.findB.hidden = isTeam;
      if (isTeam) {
        els.finderA.hidden = true;
        els.finderB.hidden = true;
      }
    }
    els.modeBtns.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

    function setView(view) {
      // "team-detail" isn't one of the nav tabs — it's reached by clicking a
      // team card — so it keeps the Teams tab looking active rather than
      // deactivating both.
      els.viewBtns.forEach((b) => b.classList.toggle("active", b.dataset.view === view || (view === "team-detail" && b.dataset.view === "teams")));
      els.viewCompare.hidden = view !== "compare";
      els.viewTeams.hidden = view !== "teams";
      els.viewTeamDetail.hidden = view !== "team-detail";
      els.viewRacers.hidden = view !== "racers";
      els.viewToday.hidden = view !== "today";
      els.viewLeaderboard.hidden = view !== "leaderboard";
      if (view === "teams") {
        renderTeamsList();
        els.teamsSearch.focus();
        TeamDirectory.markSeen();
      }
      if (view === "racers") refreshRacerDash();
      if (view === "today") refreshToday();
      if (view === "leaderboard") refreshLeaderboardView();
    }
    els.viewBtns.forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

    // In-panel team detail — click a team card in the Teams tab to see its
    // roster right here, instead of leaving to open nitrotype.com's own team
    // page in a new tab. The real page is still one click away via the
    // "Open on Nitro Type" link inside the detail view.
    async function openTeamDetail(tag) {
      setView("team-detail");
      els.teamDetailBody.innerHTML = `<div class="teams-empty">Loading [${escapeHtml(tag)}]'s roster…</div>`;
      let team;
      try {
        const onRetry = (attempt, total) =>
          (els.teamDetailBody.innerHTML = `<div class="teams-empty">Nitro Type is rate-limiting lookups right now — retrying [${escapeHtml(tag)}] (${attempt}/${total})…</div>`);
        team = await NT.fetchTeam(tag, { onRetry });
      } catch (err) {
        els.teamDetailBody.innerHTML = `<div class="teams-empty">Couldn't load [${escapeHtml(tag)}]: ${escapeHtml(err.message || "lookup failed")}</div>`;
        return;
      }
      TeamDirectory.remember(team).catch(() => {});
      const minRaces = team.trend?.minRaces ?? team.info?.minRaces ?? 0;
      const minSpeed = team.info?.minSpeed ?? 0;
      await Settings.ready;
      const isMyTeam = Settings.get().myTeam === team.tag;
      const rosterSnapshot = isMyTeam ? await RosterTrend.forTeam(team.tag) : null;
      const activity = isMyTeam ? await TeamActivity.hourlyBuckets(team.tag) : null;
      const weekStart = team.trend?.weekStart;
      const weekFraction = weekStart ? Math.min(1, Math.max(0.02, (Date.now() - weekStart) / (7 * 86400000))) : null;
      const members = (team.members || [])
        .slice()
        .sort((a, b) => (b.played || 0) - (a.played || 0));
      const rows = members
        .map((m) => {
          const name = m.displayName || m.username || "—";
          const tracked = m.username && RivalList.has(m.username);
          const trackBtn = m.username
            ? `<button type="button" class="team-detail-track${tracked ? " active" : ""}" data-u="${escapeHtml(m.username)}" title="${tracked ? "Remove from Racers dashboard" : "Add to Racers dashboard"}">${tracked ? "★" : "☆"}</button>`
            : "";
          if (!rosterSnapshot) {
            return `
              <tr>
                <td>${escapeHtml(name)}</td>
                <td>${m.played ?? 0}</td>
                <td>${trackBtn}</td>
              </tr>`;
          }
          // Captain view: extra trend + projection columns, available only
          // for your own team since that's the only roster background.js
          // keeps a day-over-day snapshot history for.
          const delta = RosterTrend.deltaFor(rosterSnapshot, m.username);
          const trendLabel = delta === null ? "—" : delta > 0 ? `+${delta} today` : delta < 0 ? `${delta} today` : "No change";
          const trendClass = delta === null ? "" : delta > 0 ? "team-detail-trend-up" : delta < 0 ? "team-detail-trend-down" : "";
          const projected = weekFraction ? Math.round((m.played || 0) / weekFraction) : null;
          const projectedLabel = projected === null ? "—" : `~${projected}`;
          return `
            <tr>
              <td>${escapeHtml(name)}</td>
              <td>${m.played ?? 0}</td>
              <td class="${trendClass}">${trendLabel}</td>
              <td>${projectedLabel}</td>
              <td>${trackBtn}</td>
            </tr>`;
        })
        .join("");
      const inactive = members
        .filter((m) => m.lastActivity)
        .slice()
        .sort((a, b) => (a.lastActivity || 0) - (b.lastActivity || 0))[0];
      const inactiveDays = inactive ? Math.floor((Date.now() / 1000 - inactive.lastActivity) / 86400) : null;
      const captainNote = rosterSnapshot
        ? `<div class="team-detail-stats">
             ${rosterSnapshot.prevDate ? "" : `<div>Trend data starts tomorrow — this is day one of tracking.</div>`}
             ${inactive ? `<div>Quietest member: <b>${escapeHtml(inactive.displayName || inactive.username)}</b> (${inactiveDays}d since last race)</div>` : ""}
           </div>`
        : "";
      // Lighthearted roster superlatives, captain's team only — reuses the
      // same played-this-week and day-over-day trend numbers the table
      // already computes, just surfaced as a fun callout instead of rows.
      const banterBlock = rosterSnapshot
        ? (() => {
            const topWeek = members.reduce((best, m) => ((m.played || 0) > (best?.played || 0) ? m : best), null);
            let hottest = null;
            let hottestDelta = 0;
            members.forEach((m) => {
              const d = RosterTrend.deltaFor(rosterSnapshot, m.username);
              if (d !== null && d > hottestDelta) {
                hottestDelta = d;
                hottest = m;
              }
            });
            const lines = [];
            if (topWeek && (topWeek.played || 0) > 0) lines.push(`🏆 Top this week: <b>${escapeHtml(topWeek.displayName || topWeek.username)}</b> (${topWeek.played} races)`);
            if (hottest) lines.push(`🔥 On fire today: <b>${escapeHtml(hottest.displayName || hottest.username)}</b> (+${hottestDelta} today)`);
            if (!lines.length) return "";
            return `<div class="team-detail-stats team-banter">${lines.map((l) => `<div>${l}</div>`).join("")}</div>`;
          })()
        : "";
      const heatmapBlock =
        activity && activity.hasData
          ? (() => {
              const max = Math.max(...activity.buckets);
              const cells = activity.buckets
                .map((v, h) => {
                  const intensity = max ? v / max : 0;
                  const label = `${h === 0 ? 12 : h > 12 ? h - 12 : h}${h < 12 ? "am" : "pm"}`;
                  return `<div class="heat-cell" style="--heat:${intensity.toFixed(2)}" title="${label}: ${v} races"></div>`;
                })
                .join("");
              return `
                <div class="team-detail-heatmap">
                  <div class="team-detail-heatmap-title">When this team races most (your local time)</div>
                  <div class="heat-row">${cells}</div>
                  <div class="heat-row-labels"><span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>11pm</span></div>
                </div>`;
            })()
          : isMyTeam
            ? `<div class="team-detail-heatmap team-detail-heatmap-empty">Still gathering activity data — check back in a day or two.</div>`
            : "";
      const watching = WatchList.has(team.tag);
      els.teamDetailBody.innerHTML = `
        <div class="team-detail-head">
          <div>
            <span class="team-detail-tag" style="color:${team.info?.tagColorPrimary ? "#" + team.info.tagColorPrimary : "var(--nt-gold)"}">[${escapeHtml(team.tag)}]</span>
            <span class="team-detail-name">${escapeHtml(team.name)}</span>
          </div>
          <button type="button" class="team-card-watch${watching ? " active" : ""}" id="team-detail-watch" title="${watching ? "Stop watching for changes" : "Watch for changes"}">${watching ? "★" : "☆"}</button>
        </div>
        <div class="team-detail-stats">
          <div>Members: <b>${team.memberCount}</b></div>
          <div>Min: <b>${minRaces} races / ${minSpeed} wpm</b></div>
          <div>Active (3d): <b>${team.trend?.activeRecentlyCount ?? "—"}</b></div>
        </div>
        ${captainNote}
        ${banterBlock}
        ${heatmapBlock}
        <table class="team-detail-table">
          <thead><tr><th>Racer</th><th>Races</th>${rosterSnapshot ? "<th>Trend</th><th>Proj. this week</th>" : ""}<th></th></tr></thead>
          <tbody>${rows || `<tr><td colspan="${rosterSnapshot ? 5 : 3}">No roster data</td></tr>`}</tbody>
        </table>
        <a class="team-detail-external" href="https://www.nitrotype.com/team/${encodeURIComponent(team.tag)}" target="_blank" rel="noopener">Open on Nitro Type ↗</a>`;
      const watchBtn = els.teamDetailBody.querySelector("#team-detail-watch");
      if (watchBtn) watchBtn.addEventListener("click", () => WatchList.toggle(team.tag).then(() => openTeamDetail(team.tag)));
      els.teamDetailBody.querySelectorAll(".team-detail-track").forEach((btn) => {
        btn.addEventListener("click", () => RivalList.toggle(btn.dataset.u).then(() => openTeamDetail(team.tag)));
      });
    }
    els.teamDetailBack.addEventListener("click", () => setView("teams"));

    // Racer dashboard — a glanceable table of every racer on the same
    // tracked list the "★ Rival" badge button builds (up to 8), fetched
    // live and shown side by side rather than one notification at a time.
    async function refreshRacerDash() {
      const usernames = RivalList.list();
      els.racersCount.textContent = `${usernames.length} racer${usernames.length === 1 ? "" : "s"} tracked`;
      if (!usernames.length) {
        els.racersDashList.innerHTML = `<div class="teams-empty">Nothing tracked yet — add a racer above, or use the ☆ Add rival button on any racer's comparison badge.</div>`;
        return;
      }
      els.racersDashList.innerHTML = `<div class="teams-empty">Loading…</div>`;
      const results = await Promise.allSettled(usernames.map((u) => NT.fetchRacer(u)));
      let entries = results.map((r, i) => ({ username: usernames[i], racer: r.status === "fulfilled" ? r.value : null }));
      // Ranking mode (anything but "order added") puts the loaded racers on
      // top, best metric first, with any that failed to load pushed to the
      // bottom — a #1 crown only makes sense once there's an actual order.
      const sortBy = els.racerDashSort.value;
      const METRIC = { speed: (r) => r.avgSpeed || 0, top: (r) => r.highestSpeed || 0, races: (r) => r.racesPlayed || 0 };
      if (METRIC[sortBy]) {
        entries = entries.slice().sort((a, b) => {
          if (!a.racer && !b.racer) return 0;
          if (!a.racer) return 1;
          if (!b.racer) return -1;
          return METRIC[sortBy](b.racer) - METRIC[sortBy](a.racer);
        });
      }
      const ranking = Boolean(METRIC[sortBy]);
      const rows = entries
        .map(({ username, racer }, i) => {
          if (!racer) {
            return `
              <div class="racer-dash-row racer-dash-row-error">
                <span>${escapeHtml(username)}</span>
                <span class="teams-empty">Couldn't load</span>
                <button type="button" class="racer-dash-remove" data-u="${escapeHtml(username)}" title="Remove">✕</button>
              </div>`;
          }
          const rank = ranking ? `<span class="racer-dash-rank">#${i + 1}</span>` : "";
          return `
            <div class="racer-dash-row">
              <span class="racer-dash-name">${rank}${escapeHtml(racer.displayName)}${racer.tag ? ` <span class="racer-dash-tag">[${escapeHtml(racer.tag)}]</span>` : ""}</span>
              <span>${racer.avgSpeed} wpm avg</span>
              <span>${racer.highestSpeed} wpm top</span>
              <span>${racer.racesPlayed.toLocaleString()} races</span>
              <button type="button" class="racer-dash-remove" data-u="${escapeHtml(racer.username)}" title="Remove">✕</button>
            </div>`;
        })
        .join("");
      els.racersDashList.innerHTML = `
        <div class="racer-dash-head">
          <span>Racer</span><span>Avg</span><span>Top</span><span>Races</span><span></span>
        </div>
        ${rows}`;
    }
    els.racerDashSort.addEventListener("change", refreshRacerDash);
    els.racerDashAdd.addEventListener("click", async () => {
      const u = els.racerDashInput.value.trim();
      if (!u) return;
      if (RivalList.has(u)) {
        els.racerDashInput.value = "";
        return;
      }
      await RivalList.toggle(u);
      els.racerDashInput.value = "";
    });
    els.racerDashInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") els.racerDashAdd.click();
    });
    els.racerDashRefresh.addEventListener("click", refreshRacerDash);
    els.racersDashList.addEventListener("click", (e) => {
      const btn = e.target.closest(".racer-dash-remove");
      if (!btn) return;
      RivalList.toggle(btn.dataset.u);
    });
    RivalList.subscribe(() => {
      if (!els.viewRacers.hidden) refreshRacerDash();
    });

    // -------------------------------------------------------------------
    // Mega leaderboard — its own top-level tab, not a Racers-tab mode.
    // Ranks EVERY racer on EVERY team this install knows about (its own
    // tracked teams plus the whole shared cross-install team network
    // pulled in via SharedTeams — TeamDirectory.list() already folds
    // both together, up to 400 teams) by all-time lifetime races, from
    // the best down to the newest racer with a handful of races. The
    // team API already returns each member's own lifetime
    // racesPlayed/avgSpeed alongside the roster, so this costs one
    // request per TEAM, not per racer — fetching thousands of individual
    // racer profiles would be far too slow and far too much load on
    // Nitro Type's API for what this is.
    // -------------------------------------------------------------------
    const LEADERBOARD_PAGE_SIZE = 100;
    let leaderboard = null; // { builtAt, teamCount, rows: [...] }
    let leaderboardPage = 0;
    let leaderboardBuilding = false;

    async function loadStoredLeaderboard() {
      const stored = await storageGet("ntcmp:racerLeaderboard");
      if (stored && Array.isArray(stored.rows)) leaderboard = stored;
    }
    loadStoredLeaderboard();

    // Merge a fresh batch of rows into whatever's currently held, keeping
    // whichever copy of a given racer has the higher lifetime race count.
    // Used both for the shared-network pull (merging in rows other
    // installs have already found) and for a local rebuild (merging in
    // this install's own fresh fetch without losing racers only the
    // shared network or a previous build knew about).
    function mergeLeaderboardRows(baseRows, newRows) {
      const byUsername = new Map(baseRows.map((r) => [r.username.toLowerCase(), r]));
      for (const r of newRows) {
        if (!r.username) continue;
        const key = r.username.toLowerCase();
        const existing = byUsername.get(key);
        if (!existing || (r.racesPlayed || 0) >= existing.racesPlayed) byUsername.set(key, r);
      }
      return Array.from(byUsername.values()).sort((a, b) => b.racesPlayed - a.racesPlayed);
    }

    // Pulls the leaderboard other installs have already built and shared,
    // so opening this tab can show a big ranked list instantly instead of
    // making every install refetch hundreds of team rosters itself. Runs
    // quietly in the background and re-renders if/when it finds anything
    // new; if the shared table doesn't exist yet (e.g. the SQL setup
    // hasn't been run) this just comes back empty and nothing changes.
    async function syncSharedLeaderboard() {
      const remoteRows = await SharedRacers.pullAll();
      if (leaderboardBuilding) return;
      if (!remoteRows.length) {
        if (!leaderboard && !els.viewLeaderboard.hidden) {
          els.leaderboardCount.textContent = "0 racers ranked";
        }
        return;
      }
      const merged = mergeLeaderboardRows(leaderboard?.rows || [], remoteRows);
      if (leaderboard && merged.length === leaderboard.rows.length) return; // nothing new
      leaderboard = { builtAt: leaderboard?.builtAt || Date.now(), teamCount: leaderboard?.teamCount || 0, rows: merged };
      await storageSet({ "ntcmp:racerLeaderboard": leaderboard });
      if (!els.viewLeaderboard.hidden) renderLeaderboardPage();
    }

    function refreshLeaderboardView() {
      if (leaderboardBuilding) return;
      if (leaderboard) renderLeaderboardPage();
      else {
        els.leaderboardCount.textContent = "Checking the shared network…";
        els.leaderboardList.innerHTML = "";
        els.leaderboardPagination.hidden = true;
        els.leaderboardNote.hidden = false;
        els.leaderboardNote.textContent =
          "Checking the shared network, and building this in the background if no one's beaten you to it — no need to do anything. Hit \"Build / Rebuild\" any time to refresh it yourself instead of waiting.";
      }
      syncSharedLeaderboard();
    }

    function renderLeaderboardPage() {
      if (!leaderboard) return;
      const rows = leaderboard.rows;
      const totalPages = Math.max(1, Math.ceil(rows.length / LEADERBOARD_PAGE_SIZE));
      leaderboardPage = Math.min(Math.max(0, leaderboardPage), totalPages - 1);
      const start = leaderboardPage * LEADERBOARD_PAGE_SIZE;
      const pageRows = rows.slice(start, start + LEADERBOARD_PAGE_SIZE);
      els.leaderboardCount.textContent = `${rows.length.toLocaleString()} racer${rows.length === 1 ? "" : "s"} ranked`;
      els.leaderboardList.innerHTML = rows.length
        ? `
          <div class="racer-dash-head racer-lb-row">
            <span>#</span><span>Racer</span><span>Team</span><span>Avg speed</span><span>Lifetime races</span>
          </div>
          ${pageRows
            .map(
              (r, i) => `
            <div class="racer-dash-row racer-lb-row">
              <span class="racer-dash-rank">#${start + i + 1}</span>
              <span class="racer-dash-name">${escapeHtml(r.displayName)}</span>
              <span class="racer-dash-tag">[${escapeHtml(r.tag)}]</span>
              <span>${r.avgSpeed} wpm</span>
              <span>${r.racesPlayed.toLocaleString()}</span>
            </div>`
            )
            .join("")}`
        : `<div class="teams-empty">None of the known teams returned any roster data.</div>`;
      els.leaderboardPagination.hidden = rows.length === 0;
      els.leaderboardPageLabel.textContent = `Page ${leaderboardPage + 1} of ${totalPages}`;
      els.leaderboardPrev.disabled = leaderboardPage === 0;
      els.leaderboardNext.disabled = leaderboardPage >= totalPages - 1;
      els.leaderboardNote.hidden = false;
      els.leaderboardNote.textContent = `Ranks racers on the ${leaderboard.teamCount} team${leaderboard.teamCount === 1 ? "" : "s"} this install knows about (your tracked teams plus the shared TypeTrack network), by all-time races. Built ${fmtSynced(leaderboard.builtAt)}.`;
    }

    async function buildLeaderboard() {
      // Pull in the latest shared team network before building, so a
      // fresh install (or one that hasn't reopened Teams in a while)
      // gets as close to the full network as possible, not just
      // whatever happened to already be cached locally.
      try {
        const remote = await SharedTeams.pullAll();
        if (remote.length) await TeamDirectory.mergeRemote(remote);
      } catch (e) {
        // Not fatal — just build from whatever's already known locally.
      }
      const teams = TeamDirectory.list();
      if (!teams.length) {
        els.leaderboardCount.textContent = "0 racers ranked";
        els.leaderboardList.innerHTML = "";
        els.leaderboardNote.hidden = false;
        els.leaderboardNote.textContent = "No teams known yet — run a Compare, or visit a team's page on nitrotype.com first.";
        els.leaderboardPagination.hidden = true;
        return;
      }
      leaderboardBuilding = true;
      els.leaderboardBuildBtn.disabled = true;
      els.leaderboardList.innerHTML = "";
      els.leaderboardPagination.hidden = true;
      let done = 0;
      const showProgress = () => {
        els.leaderboardNote.hidden = false;
        els.leaderboardNote.textContent = `Building the leaderboard — fetching ${teams.length} team${teams.length === 1 ? "" : "s"}' rosters (${done}/${teams.length})…`;
      };
      els.leaderboardCount.textContent = "Building…";
      showProgress();
      const byUsername = new Map();
      const queue = teams.slice();
      const worker = async () => {
        while (queue.length) {
          const t = queue.shift();
          try {
            const team = await NT.fetchTeam(t.tag);
            for (const m of team.members || []) {
              if (!m.username) continue;
              const key = m.username.toLowerCase();
              const existing = byUsername.get(key);
              // A racer can only be on one team at a time in Nitro Type,
              // but a stale team record could still disagree with a
              // fresher one — keep whichever has the higher lifetime
              // race count, since that's the more recently-accurate read.
              if (!existing || (m.racesPlayed || 0) >= existing.racesPlayed) {
                byUsername.set(key, {
                  username: m.username,
                  displayName: m.displayName || m.username,
                  tag: team.tag,
                  racesPlayed: m.racesPlayed || 0,
                  avgSpeed: m.avgSpeed || 0,
                });
              }
            }
          } catch (e) {
            // Skip a team that failed to load — not fatal to the rest.
          }
          done++;
          showProgress();
          await new Promise((r) => setTimeout(r, 250));
        }
      };
      // Same gentle two-at-a-time pace as the one-time team seeding, since
      // this can mean fetching hundreds of teams' rosters at once.
      await Promise.all(Array.from({ length: 2 }, worker));
      const freshRows = Array.from(byUsername.values());
      // Merge into whatever's already held rather than replacing it —
      // this install's own fresh fetch shouldn't erase racers the shared
      // network already knew about from teams this install doesn't
      // currently track.
      const rows = mergeLeaderboardRows(leaderboard?.rows || [], freshRows);
      leaderboard = { builtAt: Date.now(), teamCount: teams.length, rows };
      await storageSet({ "ntcmp:racerLeaderboard": leaderboard });
      leaderboardPage = 0;
      leaderboardBuilding = false;
      els.leaderboardBuildBtn.disabled = false;
      renderLeaderboardPage();
      // Share what this build found with every other install, so the
      // network keeps growing instead of each install rebuilding the
      // same thing from scratch. Fire-and-forget — doesn't block the UI.
      SharedRacers.pushAll(freshRows);
    }

    els.leaderboardBuildBtn.addEventListener("click", () => buildLeaderboard());
    els.leaderboardPrev.addEventListener("click", () => {
      leaderboardPage--;
      renderLeaderboardPage();
    });
    els.leaderboardNext.addEventListener("click", () => {
      leaderboardPage++;
      renderLeaderboardPage();
    });

    // Keep the leaderboard effectively always-ready rather than making the
    // first-ever visit to this tab require a manual click: on load, first
    // check the shared network (another install may have already built
    // one — nothing to do then), and only if that comes back empty too,
    // build it automatically in the background, once per install, the
    // same way the team directory self-seeds on first install. Delayed
    // well past that seeding (which takes roughly 15-20s for its ~130
    // teams at this same gentle pace) so the two background jobs don't
    // compete for Nitro Type's API at the same time, and so this build
    // benefits from however many extra teams seeding has turned up by
    // then.
    // Races played only ever goes up, teams reshuffle, and new racers show
    // up — so a leaderboard that's never rebuilt slowly goes stale. Rather
    // than leave that to a manual click, every install also quietly checks
    // on load whether what it has is more than a few days old and, if so,
    // rebuilds it in the background (at most once every few days per
    // install, so this doesn't pile on top of the shared network every
    // single page load).
    const LEADERBOARD_STALE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
    (async () => {
      // Re-await the local load here (harmless if it already finished)
      // so this always runs after it, never racing it — otherwise a
      // slow storage read could land after the sync below and clobber
      // freshly-merged data with a stale cached copy.
      await loadStoredLeaderboard();
      await syncSharedLeaderboard();
      if (leaderboardBuilding) return;

      if (!leaderboard) {
        const autoBuilt = await storageGet("ntcmp:leaderboardAutoBuilt");
        if (autoBuilt) return;
        await storageSet({ "ntcmp:leaderboardAutoBuilt": true });
        setTimeout(() => {
          if (!leaderboard && !leaderboardBuilding) buildLeaderboard();
        }, 20000);
        return;
      }

      if (Date.now() - leaderboard.builtAt > LEADERBOARD_STALE_MS) {
        const lastAttempt = (await storageGet("ntcmp:leaderboardLastAutoRebuild")) || 0;
        if (Date.now() - lastAttempt > LEADERBOARD_STALE_MS) {
          await storageSet({ "ntcmp:leaderboardLastAutoRebuild": Date.now() });
          setTimeout(() => {
            if (!leaderboardBuilding) buildLeaderboard();
          }, 20000);
        }
      }
    })();

    // "Today" tab — a one-glance check-in: today's race count against the
    // daily goal, the current/best streak, and (if "my team" is set) when
    // that team tends to race most, straight from data already tracked for
    // the progress badge and the team activity heatmap. Also hosts the
    // shareable stat-card export.
    function utcDateKey(ts) {
      return new Date(ts).toISOString().slice(0, 10);
    }
    // Mirrors background.js's own today/beforeToday comparison exactly, so
    // this matches whatever the streak logic just credited or broke.
    function racesToday(snapshots) {
      if (!snapshots || snapshots.length < 2) return null;
      const today = utcDateKey(Date.now());
      const last = snapshots[snapshots.length - 1];
      if (utcDateKey(last.ts) !== today) return null; // no snapshot taken yet today
      const beforeToday = [...snapshots].reverse().find((s) => utcDateKey(s.ts) !== today);
      if (!beforeToday) return null;
      return Math.max(0, (last.racesPlayed || 0) - (beforeToday.racesPlayed || 0));
    }

    function fmtHour(h) {
      return `${h === 0 ? 12 : h > 12 ? h - 12 : h}${h < 12 ? "am" : "pm"}`;
    }

    async function refreshToday() {
      els.todayBody.innerHTML = `<div class="teams-empty">Loading…</div>`;
      const [goal, streak, bestStreak, snapshots] = await Promise.all([
        Progress.getGoal(),
        Progress.getStreak(),
        Progress.getBestStreak(),
        Progress.list(),
      ]);
      await Settings.ready;
      const { myTeam, myRacer } = Settings.get();
      const todayCount = racesToday(snapshots);

      if (!myTeam && !myRacer && !snapshots.length) {
        els.todayBody.innerHTML = `<div class="teams-empty">Set "my team" / "my racer" in ⚙ Settings to start tracking a daily check-in here.</div>`;
        return;
      }

      const goalLine = goal
        ? `<div>Daily goal: <b>${goal}</b> races${todayCount !== null ? ` — <b>${todayCount}</b> so far today` : ""}</div>`
        : `<div>No daily goal set — add one in ⚙ Settings to start a streak.</div>`;
      const streakLine =
        streak || bestStreak
          ? `<div>🔥 Current streak: <b>${streak}</b> day${streak === 1 ? "" : "s"}${bestStreak > streak ? ` (best: ${bestStreak})` : ""}</div>`
          : "";

      let teamLine = `<div>Set your team in ⚙ Settings to see its activity here.</div>`;
      if (myTeam) {
        try {
          const activity = await TeamActivity.hourlyBuckets(myTeam);
          teamLine = activity.hasData
            ? `<div>Your team [${escapeHtml(myTeam)}] races most around <b>${fmtHour(activity.buckets.indexOf(Math.max(...activity.buckets)))}</b> (your local time)</div>`
            : `<div>Still gathering [${escapeHtml(myTeam)}]'s activity data — check back in a day or two.</div>`;
        } catch (e) {
          teamLine = "";
        }
      }

      els.todayBody.innerHTML = `
        <div class="team-detail-stats">
          ${goalLine}
          ${streakLine}
          ${teamLine}
        </div>
        <button type="button" class="team-finder-btn" id="today-share-btn">📷 Share stat card</button>`;
      const shareBtn = els.todayBody.querySelector("#today-share-btn");
      if (shareBtn) {
        shareBtn.addEventListener("click", () => {
          shareBtn.textContent = "Generating…";
          generateShareCard({ goal, streak, bestStreak, snapshots, myTeam, myRacer });
          setTimeout(() => (shareBtn.textContent = "📷 Share stat card"), 1200);
        });
      }
    }

    // Draws a shareable PNG stat card on a plain <canvas> (no external
    // images, so no CORS concerns) and triggers a download — for posting
    // progress to a team Discord or elsewhere outside the extension.
    function generateShareCard({ goal, streak, bestStreak, snapshots, myTeam, myRacer }) {
      const style = getComputedStyle(document.documentElement);
      const red = (style.getPropertyValue("--ntcmp-theme-red") || "").trim() || "#d62f3a";
      const gold = (style.getPropertyValue("--ntcmp-theme-gold") || "").trim() || "#f0c75e";
      const last = snapshots[snapshots.length - 1] || {};
      const lifetimeRaces = last.racesPlayed || 0;
      const avgSpeed = last.avgSpeed || 0;

      const canvas = document.createElement("canvas");
      canvas.width = 900;
      canvas.height = 500;
      const ctx = canvas.getContext("2d");

      const bgGrad = ctx.createLinearGradient(0, 0, 900, 500);
      bgGrad.addColorStop(0, "#0b1626");
      bgGrad.addColorStop(1, "#13223a");
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, 900, 500);
      ctx.strokeStyle = gold;
      ctx.lineWidth = 8;
      ctx.strokeRect(12, 12, 876, 476);

      ctx.fillStyle = red;
      ctx.font = "bold 34px Montserrat, sans-serif";
      ctx.fillText("⚡ TYPETRACK", 48, 80);
      ctx.fillStyle = "#f0f4fa";
      ctx.font = "600 26px Montserrat, sans-serif";
      ctx.fillText(myRacer || "Racer", 48, 128);

      const stat = (x, y, value, label, color) => {
        ctx.fillStyle = color;
        ctx.font = "bold 56px Montserrat, sans-serif";
        ctx.fillText(String(value), x, y);
        ctx.fillStyle = "#8fa3bf";
        ctx.font = "18px Montserrat, sans-serif";
        ctx.fillText(label, x, y + 28);
      };
      stat(48, 240, lifetimeRaces.toLocaleString(), "LIFETIME RACES", gold);
      stat(470, 240, avgSpeed, "AVG SPEED (WPM)", gold);
      stat(48, 390, streak || 0, `DAY STREAK${bestStreak ? ` · BEST ${bestStreak}` : ""}`, red);
      if (myTeam) stat(470, 390, `[${myTeam}]`, "TEAM", "#f0f4fa");
      else if (goal) stat(470, 390, goal, "DAILY GOAL (RACES)", "#f0f4fa");

      ctx.fillStyle = "#8fa3bf";
      ctx.font = "16px Montserrat, sans-serif";
      ctx.fillText("nitrotype.com — tracked with TypeTrack", 48, 460);

      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = `typetrack-${(myRacer || "stats").replace(/[^a-z0-9_-]/gi, "")}-${Date.now()}.png`;
      a.click();
    }

    // Quick-invite — copies an install link + blurb to the clipboard so
    // it's easy to paste into a team Discord/chat without hunting for the
    // repo link yourself.
    els.settingsInviteBtn.addEventListener("click", async () => {
      const text =
        "TypeTrack — a free Chrome extension for Nitro Type: compare teams/racers, browse every team you've looked up, " +
        "a captain's view of your own roster, and on-page alerts, right inside nitrotype.com.\n" +
        "Download: https://github.com/thevoidracer/nt-head-to-head/archive/refs/heads/main.zip\n" +
        "Install: unzip it, go to chrome://extensions, turn on Developer mode, click \"Load unpacked\", and pick the folder.";
      const btn = els.settingsInviteBtn;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = "✓ Copied!";
      } catch (e) {
        btn.textContent = "Couldn't copy — select & copy manually";
      }
      setTimeout(() => (btn.textContent = "📋 Share TypeTrack"), 1800);
    });

    // Full "Teams" tab — every team this install knows about (seeded +
    // auto-grown, see TeamDirectory above), searchable, the same spirit as
    // TypeTrack's own site-wide team filterer. Clicking a card opens that
    // team's real nitrotype.com page (to compare it, type its tag into
    // either Compare field — the autocomplete remembers every team here).
    function fmtFormed(ms) {
      if (!ms) return "—";
      return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    }
    function fmtSynced(ms) {
      if (!ms) return "";
      return new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
    }

    const TEAM_SORTERS = {
      tag: (a, b) => a.tag.localeCompare(b.tag),
      "members-desc": (a, b) => (b.members ?? 0) - (a.members ?? 0),
      "members-asc": (a, b) => (a.members ?? 0) - (b.members ?? 0),
      "formed-desc": (a, b) => (b.formed ?? 0) - (a.formed ?? 0),
      "formed-asc": (a, b) => (a.formed ?? 0) - (b.formed ?? 0),
      "speed-asc": (a, b) => (a.minSpeed ?? 0) - (b.minSpeed ?? 0),
      "speed-desc": (a, b) => (b.minSpeed ?? 0) - (a.minSpeed ?? 0),
    };

    // Live-fetched performance stats for the current leaderboard ranking —
    // see the "🏆 Leaderboard" button below. Nitro Type doesn't publish a
    // full list of every team, so this only ever ranks the teams this
    // install already knows about (currently shown, after filters), never
    // the whole game — that caveat is spelled out in the note shown with
    // it, rather than claiming a "global" leaderboard this data can't back.
    let leaderboardResults = null; // tag -> { speed, points, accuracy } | null

    function exitLeaderboard() {
      if (!leaderboardResults) return;
      leaderboardResults = null;
      els.teamLeaderboardBtn.textContent = "🏆 Leaderboard";
      els.teamLeaderboardNote.hidden = true;
    }

    function renderTeamsList() {
      const q = els.teamsSearch.value.trim().toLowerCase();
      const maxSpeed = els.teamsMaxSpeed.value === "" ? null : Number(els.teamsMaxSpeed.value);
      const maxRaces = els.teamsMaxRaces.value === "" ? null : Number(els.teamsMaxRaces.value);
      const minMembers = els.teamsMinMembers.value === "" ? null : Number(els.teamsMinMembers.value);
      const sortBy = els.teamsSort.value;

      const all = TeamDirectory.list();
      const items = all
        .filter((t) => !q || t.tag.toLowerCase().includes(q) || t.name.toLowerCase().includes(q))
        .filter((t) => maxSpeed === null || (t.minSpeed ?? 0) <= maxSpeed)
        .filter((t) => maxRaces === null || (t.minRaces ?? 0) <= maxRaces)
        .filter((t) => minMembers === null || (t.members ?? 0) >= minMembers)
        .sort(TEAM_SORTERS[sortBy] || TEAM_SORTERS.tag);
      const filtered = q || maxSpeed !== null || maxRaces !== null || minMembers !== null;
      const watchedCount = WatchList.list().length;

      if (leaderboardResults) {
        const ranked = items
          .map((t) => ({ t, stats: leaderboardResults[t.tag] }))
          .filter((x) => x.stats)
          .sort((a, b) => (b.stats.speed || 0) - (a.stats.speed || 0));
        els.teamsCount.textContent = `${ranked.length} ranked (of ${items.length} shown)`;
        els.teamsList.innerHTML = ranked.length
          ? ranked
              .map(({ t, stats }, i) => {
                const color = t.color ? `#${t.color}` : "var(--nt-gold)";
                return `
                  <div class="team-card team-card-ranked" data-tag="${escapeHtml(t.tag)}" style="--team-color:${color}" tabindex="0" role="button">
                    <div class="team-card-rank">#${i + 1}</div>
                    <div class="team-card-head"><span class="team-card-tag" style="color:${color}">[${escapeHtml(t.tag)}]</span> <span class="team-card-name">${escapeHtml(t.name)}</span></div>
                    <div class="team-card-row">Avg speed: <b>${stats.speed} wpm</b> · Points: <b>${Math.round(stats.points).toLocaleString()}</b> · Accuracy: <b>${stats.accuracy}%</b></div>
                    <div class="team-card-row">Members: <b>${t.members ?? "—"}</b></div>
                    <div class="team-card-foot"><span class="team-card-link">View roster</span></div>
                  </div>`;
              })
              .join("")
          : `<div class="teams-empty">None of these teams had recent race data to rank.</div>`;
        return;
      }

      els.teamsCount.textContent =
        (filtered ? `${items.length} of ${all.length} teams tracked` : `${all.length} teams tracked`) +
        (watchedCount ? ` · ${watchedCount} watched` : "");
      els.teamsList.innerHTML = items.length
        ? items
            .map((t) => {
              const color = t.color ? `#${t.color}` : "var(--nt-gold)";
              const watching = WatchList.has(t.tag);
              return `
                <div class="team-card" data-tag="${escapeHtml(t.tag)}" style="--team-color:${color}" tabindex="0" role="button">
                  <button type="button" class="team-card-watch${watching ? " active" : ""}" data-tag="${escapeHtml(t.tag)}" title="${watching ? "Stop watching for changes" : "Watch for changes (captain, requirements, member swings)"}">${watching ? "★" : "☆"}</button>
                  <div class="team-card-head"><span class="team-card-tag" style="color:${color}">[${escapeHtml(t.tag)}]</span> <span class="team-card-name">${escapeHtml(t.name)}</span></div>
                  <div class="team-card-row">Captain: <b>${escapeHtml(t.captain || "—")}</b></div>
                  <div class="team-card-row">Members: <b>${t.members ?? "—"}</b> · Formed: <b>${fmtFormed(t.formed)}</b></div>
                  <div class="team-card-row">Min: <b>${t.minRaces ?? 0} races / ${t.minSpeed ?? 0} wpm</b></div>
                  <div class="team-card-foot">
                    <span class="team-card-link">View roster</span>
                    ${t.syncedAt ? `<span class="team-card-synced">Synced ${fmtSynced(t.syncedAt)}</span>` : ""}
                  </div>
                </div>`;
            })
            .join("")
        : filtered
          ? `<div class="teams-empty">No teams match those filters. <button type="button" class="empty-action" id="teams-empty-clear">Clear filters</button></div>`
          : `<div class="teams-empty">No teams tracked yet — run a Compare, or just visit a team's page on nitrotype.com and it'll show up here.</div>`;
      const clearLink = els.teamsList.querySelector("#teams-empty-clear");
      if (clearLink) clearLink.addEventListener("click", () => els.teamsFiltersClear.click());
    }
    [els.teamsSearch, els.teamsMaxSpeed, els.teamsMaxRaces, els.teamsMinMembers].forEach((el) =>
      el.addEventListener("input", () => {
        // Changing what's shown invalidates whatever was just ranked.
        exitLeaderboard();
        renderTeamsList();
      })
    );
    els.teamsSort.addEventListener("change", () => {
      exitLeaderboard();
      renderTeamsList();
    });
    // Event delegation: the star buttons get wiped and recreated on every
    // render, so listen on the stable grid container instead of each card.
    els.teamsList.addEventListener("click", (e) => {
      const watchBtn = e.target.closest(".team-card-watch");
      if (watchBtn) {
        e.preventDefault();
        e.stopPropagation();
        WatchList.toggle(watchBtn.dataset.tag);
        return;
      }
      const card = e.target.closest(".team-card");
      if (card) openTeamDetail(card.dataset.tag);
    });
    els.teamsList.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const card = e.target.closest(".team-card");
      if (!card) return;
      e.preventDefault();
      openTeamDetail(card.dataset.tag);
    });
    WatchList.subscribe(() => {
      if (!els.viewTeams.hidden) renderTeamsList();
    });
    els.teamsFiltersClear.addEventListener("click", () => {
      els.teamsSearch.value = "";
      els.teamsSort.value = "tag";
      els.teamsMaxSpeed.value = "";
      els.teamsMaxRaces.value = "";
      els.teamsMinMembers.value = "";
      els.teamFinderNote.hidden = true;
      exitLeaderboard();
      renderTeamsList();
    });

    // Team finder — reverse the usual comparison: given your own avg
    // speed, which tracked teams have you already clearing their speed
    // requirement? Reuses the existing "Max min speed" filter plumbing
    // rather than building a second results view.
    els.teamFinderBtn.addEventListener("click", async () => {
      await Settings.ready;
      const { myRacer } = Settings.get();
      if (!myRacer) {
        els.teamFinderNote.hidden = false;
        els.teamFinderNote.textContent = "Set \"My racer username\" in ⚙ settings first, so there's a speed to match teams against.";
        return;
      }
      els.teamFinderBtn.disabled = true;
      els.teamFinderBtn.textContent = "Finding…";
      try {
        const racer = await NT.fetchRacer(myRacer);
        els.teamsMaxSpeed.value = Math.floor(racer.avgSpeed || 0);
        els.teamsSort.value = "speed-desc";
        exitLeaderboard();
        renderTeamsList();
        els.teamFinderNote.hidden = false;
        els.teamFinderNote.textContent = `Showing tracked teams you'd already clear the speed requirement for (your avg: ${racer.avgSpeed} wpm), toughest first. Meeting a team's race requirement is still up to how much you play.`;
      } catch (err) {
        els.teamFinderNote.hidden = false;
        els.teamFinderNote.textContent = err.message || "Couldn't look up your racer stats.";
      } finally {
        els.teamFinderBtn.disabled = false;
        els.teamFinderBtn.textContent = "Find teams for me";
      }
    });

    // Leaderboard — ranks whichever teams are currently shown (after
    // search/filters) by real race performance (season avg speed, with
    // points/accuracy alongside), live-fetched a couple at a time so it
    // stays a polite burst rather than hammering NT's API. This is the
    // teams this install already knows about, not a global ranking —
    // Nitro Type doesn't publish a full team list to build that from.
    els.teamLeaderboardBtn.addEventListener("click", async () => {
      if (leaderboardResults) {
        exitLeaderboard();
        renderTeamsList();
        return;
      }
      const q = els.teamsSearch.value.trim().toLowerCase();
      const maxSpeed = els.teamsMaxSpeed.value === "" ? null : Number(els.teamsMaxSpeed.value);
      const maxRaces = els.teamsMaxRaces.value === "" ? null : Number(els.teamsMaxRaces.value);
      const minMembers = els.teamsMinMembers.value === "" ? null : Number(els.teamsMinMembers.value);
      const candidates = TeamDirectory.list()
        .filter((t) => !q || t.tag.toLowerCase().includes(q) || t.name.toLowerCase().includes(q))
        .filter((t) => maxSpeed === null || (t.minSpeed ?? 0) <= maxSpeed)
        .filter((t) => maxRaces === null || (t.minRaces ?? 0) <= maxRaces)
        .filter((t) => minMembers === null || (t.members ?? 0) >= minMembers)
        .slice(0, 25);
      if (!candidates.length) {
        els.teamLeaderboardNote.hidden = false;
        els.teamLeaderboardNote.textContent = "Nothing to rank yet — track a few teams first (run a Compare, or visit a team's page on nitrotype.com).";
        return;
      }
      els.teamLeaderboardBtn.disabled = true;
      const results = {};
      let done = 0;
      const showProgress = () => {
        els.teamLeaderboardNote.hidden = false;
        els.teamLeaderboardNote.textContent = `Ranking ${candidates.length} tracked team${candidates.length === 1 ? "" : "s"} by real performance — ${done}/${candidates.length}…`;
      };
      showProgress();
      const queue = candidates.slice();
      const worker = async () => {
        while (queue.length) {
          const t = queue.shift();
          try {
            const team = await NT.fetchTeam(t.tag);
            const board = team.boards?.season || team.boards?.alltime;
            results[t.tag] = board ? { speed: board.speed, points: board.points, accuracy: board.accuracy } : null;
          } catch (e) {
            results[t.tag] = null;
          }
          done++;
          showProgress();
          await new Promise((r) => setTimeout(r, 200));
        }
      };
      await Promise.all(Array.from({ length: 2 }, worker));
      leaderboardResults = results;
      els.teamLeaderboardBtn.disabled = false;
      els.teamLeaderboardBtn.textContent = "← Back to list";
      els.teamLeaderboardNote.textContent = `Top tracked teams by avg speed (this season) — ranked from the ${candidates.length} team${candidates.length === 1 ? "" : "s"} currently shown here, not every team in Nitro Type.`;
      renderTeamsList();
    });

    TeamDirectory.subscribe(() => {
      if (!els.viewTeams.hidden) renderTeamsList();
    });

    function wireFinder(side) {
      const findBtn = side === "a" ? els.findA : els.findB;
      const panel = side === "a" ? els.finderA : els.finderB;
      const mainInput = side === "a" ? els.inputA : els.inputB;
      const teamInput = panel.querySelector(".finder-team-input");
      const loadBtn = panel.querySelector(".finder-load-btn");
      const rosterSelect = panel.querySelector(".finder-roster");
      const statusEl = panel.querySelector(".finder-status");

      findBtn.addEventListener("click", () => {
        panel.hidden = !panel.hidden;
        if (!panel.hidden) teamInput.focus();
      });

      async function loadRoster() {
        const tag = teamInput.value.trim();
        if (!tag) return;
        statusEl.textContent = "Loading roster…";
        statusEl.classList.remove("error");
        rosterSelect.hidden = true;
        loadBtn.disabled = true;
        try {
          const team = await NT.fetchTeam(tag);
          await TeamDirectory.remember(team);
          const members = (team.members || []).slice().sort((m1, m2) => m1.displayName.localeCompare(m2.displayName));
          rosterSelect.innerHTML = members
            .map((m) => `<option value="${m.username}">${escapeHtml(m.displayName)} — ${escapeHtml(m.username)}</option>`)
            .join("");
          rosterSelect.hidden = false;
          statusEl.textContent = `${members.length} members loaded. Pick one below.`;
        } catch (err) {
          statusEl.textContent = err.message || "Couldn't load that team.";
          statusEl.classList.add("error");
        } finally {
          loadBtn.disabled = false;
        }
      }

      loadBtn.addEventListener("click", loadRoster);
      teamInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          loadRoster();
        }
      });
      rosterSelect.addEventListener("change", () => {
        if (rosterSelect.value) {
          mainInput.value = rosterSelect.value;
          panel.hidden = true;
        }
      });
    }
    wireFinder("a");
    wireFinder("b");

    // Bar + duel-score presentation borrowed from StarTrack's "Showdown"
    // comparator (the community leaderboard site startrack.org): every row
    // gets a two-color lead bar under the numbers, and every render tallies
    // how many stat rows each side won into a "duel score" strip up top —
    // same idea as their "BEEHVE 10 – 5 TCHR" summary, built from the one
    // snapshot we already fetch rather than StarTrack's tracked history.
    function statBar(an, bn) {
      if (Number.isNaN(an) || Number.isNaN(bn)) return "";
      const total = Math.abs(an) + Math.abs(bn);
      const aPct = total ? Math.round((Math.abs(an) / total) * 100) : 50;
      const bPct = 100 - aPct;
      return `
        <div class="stat-bar">
          <div class="stat-bar-a" style="width:${aPct}%"></div>
          <div class="stat-bar-b" style="width:${bPct}%"></div>
        </div>`;
    }

    function statRow(label, aVal, bVal, { higherIsBetter = true, suffix = "", noWin = false, bar = true, tally = null } = {}) {
      const an = typeof aVal === "number" ? aVal : parseFloat(aVal);
      const bn = typeof bVal === "number" ? bVal : parseFloat(bVal);
      let aWin = false, bWin = false;
      if (!noWin && !Number.isNaN(an) && !Number.isNaN(bn) && an !== bn) {
        if (higherIsBetter ? an > bn : an < bn) aWin = true;
        else bWin = true;
      }
      if (tally && !noWin) {
        if (aWin) tally.a++;
        else if (bWin) tally.b++;
      }
      return `
        <div class="stat-row">
          <span class="stat-val a ${aWin ? "win" : ""}">${aVal ?? "—"}${suffix}</span>
          <span class="stat-label">${label}</span>
          <span class="stat-val b ${bWin ? "win" : ""}">${bVal ?? "—"}${suffix}</span>
          ${bar && !noWin ? statBar(an, bn) : ""}
        </div>`;
    }

    function duelScore(tally, aName, bName) {
      if (tally.a === 0 && tally.b === 0) return "";
      const aLead = tally.a > tally.b;
      const bLead = tally.b > tally.a;
      return `
        <div class="duel-score">
          <span class="duel-val a ${aLead ? "lead" : ""}">${tally.a}</span>
          <span class="duel-mid">STATS WON</span>
          <span class="duel-val b ${bLead ? "lead" : ""}">${tally.b}</span>
        </div>`;
    }

    function renderTeams(a, b) {
      const tally = { a: 0, b: 0 };
      const boardRows = (boardName, title) => {
        const ba = a.boards[boardName];
        const bb = b.boards[boardName];
        if (!ba && !bb) return "";
        return `
          <div class="section-title">${title}</div>
          ${statRow("Races", ba?.races ?? 0, bb?.races ?? 0, { tally })}
          ${statRow("Avg speed", ba?.speed ?? 0, bb?.speed ?? 0, { suffix: " wpm", tally })}
          ${statRow("Accuracy", ba?.accuracy ?? 0, bb?.accuracy ?? 0, { suffix: "%", tally })}
          ${statRow("Points", ba?.points ?? 0, bb?.points ?? 0, { tally })}
          ${statRow("Points/race", ba?.ppr ?? 0, bb?.ppr ?? 0, { tally })}`;
      };
      const paceLine = (t) =>
        t.trend.minRaces
          ? `<b>${t.trend.onPaceCount}/${t.trend.eligibleCount}</b> members on pace for the ${t.trend.minRaces}-race weekly requirement`
          : `No weekly race requirement set`;
      const body = `
        <div class="section-title">Roster</div>
        ${statRow("Members", a.memberCount, b.memberCount, { tally })}
        ${statRow("Active %", a.trend.activePercent, b.trend.activePercent, { suffix: "%", tally })}
        ${statRow("Active (≤3d)", a.trend.activeRecentlyCount, b.trend.activeRecentlyCount, { tally })}
        ${boardRows("alltime", "All-time")}
        ${boardRows("season", "This season")}
        ${boardRows("daily", "Today")}
        <div class="section-title">This week</div>
        <div class="trend-note">${a.tag}: ${paceLine(a)}</div>
        <div class="trend-note">${b.tag}: ${paceLine(b)}</div>`;
      return `
        <div class="names">
          <span class="name-cell a">[${a.tag}] ${escapeHtml(a.name)}</span>
          <span class="vs-mid">vs</span>
          <span class="name-cell b">${escapeHtml(b.name)} [${b.tag}]</span>
        </div>
        ${duelScore(tally, a.tag, b.tag)}
        ${body}`;
    }

    function renderRacers(a, b) {
      const tally = { a: 0, b: 0 };
      const fmtAge = (days) => {
        if (days == null) return "—";
        if (days < 30) return `${days}d`;
        if (days < 365) return `${Math.round(days / 30)}mo`;
        return `${(days / 365).toFixed(1)}yr`;
      };
      const body = `
        <div class="section-title">Profile</div>
        ${statRow("Level", a.level, b.level, { tally })}
        ${statRow("Lifetime races", a.racesPlayed, b.racesPlayed, { tally })}
        ${statRow("Avg speed", a.avgSpeed, b.avgSpeed, { suffix: " wpm", tally })}
        ${statRow("Top speed", a.highestSpeed, b.highestSpeed, { suffix: " wpm", tally })}
        <div class="section-title">Extras</div>
        ${statRow("League tier", a.leagueTier, b.leagueTier, { tally })}
        ${statRow("Membership", a.membership, b.membership, { noWin: true, bar: false })}
        ${statRow("Longest session", a.longestSession, b.longestSession, { suffix: " min", tally })}
        ${statRow("Racing since", fmtAge(a.accountAgeDays), fmtAge(b.accountAgeDays), { noWin: true, bar: false })}
        <div class="trend-note">Nitro Type's racer pages no longer expose a season/daily breakdown, so this is lifetime data only — not a recent-form snapshot.</div>`;
      return `
        <div class="names">
          <span class="name-cell a">${escapeHtml(a.displayName)}${a.tag ? ` [${a.tag}]` : ""}</span>
          <span class="vs-mid">vs</span>
          <span class="name-cell b">${escapeHtml(b.displayName)}${b.tag ? ` [${b.tag}]` : ""}</span>
        </div>
        ${duelScore(tally, a.displayName, b.displayName)}
        ${body}`;
    }

    function setStatus(msg, isError = false) {
      if (!msg) {
        els.status.hidden = true;
        return;
      }
      els.status.hidden = false;
      els.status.textContent = msg;
      els.status.classList.toggle("error", isError);
    }

    els.form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const a = els.inputA.value.trim();
      const b = els.inputB.value.trim();
      if (!a || !b) {
        setStatus("Enter both names to compare.", true);
        return;
      }
      els.btn.disabled = true;
      els.result.hidden = true;
      setStatus("Fetching…");
      try {
        const fetchFn = state.mode === "team" ? NT.fetchTeam : NT.fetchRacer;
        const onRetry = (attempt, total) => setStatus(`Nitro Type is rate-limiting lookups right now — retrying (${attempt}/${total})…`);
        const [dataA, dataB] = await Promise.all([fetchFn(a, { onRetry }), fetchFn(b, { onRetry })]);
        setStatus("");
        els.result.innerHTML = state.mode === "team" ? renderTeams(dataA, dataB) : renderRacers(dataA, dataB);
        els.result.hidden = false;
        els.exportCsvBtn.hidden = false;
        if (state.mode === "team") {
          TeamDirectory.remember(dataA);
          TeamDirectory.remember(dataB);
        }
        CompareHistory.add(state.mode, dataA, dataB);
      } catch (err) {
        setStatus(err.message || "Something went wrong.", true);
      } finally {
        els.btn.disabled = false;
      }
    });

    function fmtHistoryWhen(ts) {
      const mins = Math.round((Date.now() - ts) / 60000);
      if (mins < 1) return "just now";
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.round(mins / 60);
      if (hrs < 24) return `${hrs}h ago`;
      return `${Math.round(hrs / 24)}d ago`;
    }
    function historyLabel(mode, side) {
      return mode === "team" ? `[${side.tag}]` : side.displayName || side.username;
    }
    function renderCompareHistory() {
      const items = CompareHistory.list();
      els.compareHistory.innerHTML = items.length
        ? `<button type="button" class="history-clear" id="history-clear">Clear history</button>` +
          items
            .map(
              (entry, i) => `
              <button type="button" class="history-entry" data-i="${i}">
                <span>${historyLabel(entry.mode, entry.a)} <span class="history-vs">vs</span> ${historyLabel(entry.mode, entry.b)}</span>
                <span class="history-when">${fmtHistoryWhen(entry.ts)}</span>
              </button>`
            )
            .join("")
        : `<div class="teams-empty">No saved comparisons yet — run a Compare and it'll show up here.</div>`;
    }
    els.historyToggle.addEventListener("click", () => {
      els.compareHistory.hidden = !els.compareHistory.hidden;
      if (!els.compareHistory.hidden) renderCompareHistory();
    });
    els.compareHistory.addEventListener("click", (e) => {
      if (e.target.closest("#history-clear")) {
        CompareHistory.clear();
        renderCompareHistory();
        return;
      }
      const entryBtn = e.target.closest(".history-entry");
      if (!entryBtn) return;
      const entry = CompareHistory.list()[Number(entryBtn.dataset.i)];
      if (!entry) return;
      setMode(entry.mode);
      els.inputA.value = entry.mode === "team" ? entry.a.tag : entry.a.username;
      els.inputB.value = entry.mode === "team" ? entry.b.tag : entry.b.username;
      setStatus("");
      els.result.innerHTML =
        `<div class="history-saved-note">Saved comparison from ${fmtHistoryWhen(entry.ts)} — run Compare again for current numbers.</div>` +
        (entry.mode === "team" ? renderTeams(entry.a, entry.b) : renderRacers(entry.a, entry.b));
      els.result.hidden = false;
      els.exportCsvBtn.hidden = false;
      els.compareHistory.hidden = true;
    });
    function csvCell(s) {
      const str = String(s ?? "");
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    }
    function downloadText(filename, text, mime) {
      const blob = new Blob([text], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }
    els.exportCsvBtn.addEventListener("click", () => {
      const nameA = els.result.querySelector(".name-cell.a")?.textContent.trim() || "A";
      const nameB = els.result.querySelector(".name-cell.b")?.textContent.trim() || "B";
      const rows = [["Stat", nameA, nameB]];
      els.result.querySelectorAll(".stat-row").forEach((row) => {
        const label = row.querySelector(".stat-label")?.textContent.trim() || "";
        const a = row.querySelector(".stat-val.a")?.textContent.trim() || "";
        const b = row.querySelector(".stat-val.b")?.textContent.trim() || "";
        rows.push([label, a, b]);
      });
      const csv = rows.map((r) => r.map(csvCell).join(",")).join("\n");
      downloadText(`typetrack-compare-${Date.now()}.csv`, csv, "text/csv");
    });

    CompareHistory.subscribe(() => {
      if (!els.compareHistory.hidden) renderCompareHistory();
    });

    function open() {
      state.open = true;
      els.panel.classList.add("open");
      els.backdrop.classList.add("open");
      // Opening the panel counts as "noticed" for the version-update half
      // of the nav dot (the unseen-teams half still clears specifically
      // when the Teams tab itself is opened, via TeamDirectory.markSeen()).
      markVersionSeen().then(refreshNavBadge);
      // Prefill side A from the current page, same spirit as before — and
      // if the current page doesn't give us anything, fall back to your
      // own team/racer (from Settings) so side A isn't just sitting empty
      // for a comparison you're about to run anyway.
      const teamMatch = location.pathname.match(/^\/team\/([^/?#]+)/i);
      const racerMatch = location.pathname.match(/^\/racer\/([^/?#]+)/i);
      if (teamMatch && !els.inputA.value) {
        setMode("team");
        els.inputA.value = decodeURIComponent(teamMatch[1]);
      } else if (racerMatch && !els.inputA.value) {
        setMode("racer");
        els.inputA.value = decodeURIComponent(racerMatch[1]);
      } else if (!els.inputA.value) {
        const { myTeam, myRacer } = Settings.get();
        if (state.mode === "team" && myTeam) els.inputA.value = myTeam;
        else if (state.mode === "racer" && myRacer) els.inputA.value = myRacer;
      }
    }
    function close() {
      state.open = false;
      els.panel.classList.remove("open");
      els.backdrop.classList.remove("open");
    }
    function toggle() {
      if (state.open) close();
      else open();
    }

    // Driven by the on-page comparison badges (TeamBadge/RacerBadge): pop
    // the panel straight to a filled-in, already-submitted Compare.
    function compareTeams(a, b) {
      setMode("team");
      setView("compare");
      els.inputA.value = a;
      els.inputB.value = b;
      els.form.requestSubmit();
    }
    function compareRacers(a, b) {
      setMode("racer");
      setView("compare");
      els.inputA.value = a;
      els.inputB.value = b;
      els.form.requestSubmit();
    }

    els.raceNowBtn.addEventListener("click", () => close());
    els.closeBtn.addEventListener("click", close);
    els.backdrop.addEventListener("click", close);

    // Keyboard shortcuts. This listener sits on the real page's document,
    // not our shadow root, so every keystroke anywhere on nitrotype.com
    // passes through it — guard on "not currently typing" (no text input,
    // textarea, or contenteditable focused, and no modifier NT itself
    // might use) before treating anything but Escape as ours.
    function isTyping() {
      const el = document.activeElement;
      if (!el) return false;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return true;
      // Our own panel inputs live inside this shadow root, which
      // document.activeElement doesn't see into directly — check that too.
      const active = root.activeElement;
      return !!active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA");
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.open) {
        close();
        return;
      }
      // Alt+T toggles the panel open/closed from anywhere on the page.
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "t" && !isTyping()) {
        e.preventDefault();
        toggle();
        return;
      }
      if (!state.open || isTyping()) return;
      if (e.key === "1") setView("compare");
      else if (e.key === "2") setView("teams");
      else if (e.key === "3") setView("racers");
      else if (e.key === "4") setView("today");
      else if (e.key === "5") setView("leaderboard");
      else if (e.key === "/" && !els.viewTeams.hidden) {
        e.preventDefault();
        els.teamsSearch.focus();
      }
    });

    setMode("team");
    setView("compare");

    return { open, close, toggle, compareTeams, compareRacers };
  }

  const PANEL_CSS = `
    :host, * { box-sizing: border-box; }
    [hidden] { display: none !important; }

    /* Palette and type sampled straight from the live site: Montserrat (the
       same @font-face Nitro Type's own page already loads document-wide, so
       this just references it rather than shipping a second font), the
       exact red its race/CTA buttons use, and the chunky, deeply-rounded,
       beveled "game button" look instead of a flat SaaS one. */
    :host {
      --nt-bg: #0b1626;
      --nt-panel: #13223a;
      --nt-panel-raised: #1a2d4a;
      --nt-line: #24395c;
      --nt-text: #f0f4fa;
      --nt-dim: #8fa3bf;
      /* Theme-able: set on documentElement by the Theme module below, so
         every shadow root on the page (the panel, and each badge's own
         separate shadow root) picks up the same choice without having to
         be threaded through individually — custom properties inherit
         across shadow boundaries from an outer ancestor. */
      --nt-red: var(--ntcmp-theme-red, #d62f3a);
      --nt-red-dim: #3a1414;
      --nt-gold: var(--ntcmp-theme-gold, #f0c75e);
      --nt-font: "Montserrat", "Manrope", "Segoe UI", Roboto, system-ui, sans-serif;
      --nt-radius-lg: 20px;
      --nt-radius: 10px;
      --nt-radius-sm: 7px;
      --nt-bevel: inset 0 -3px 0 rgba(0,0,0,0.25);
    }

    .backdrop {
      position: fixed; inset: 0; background: rgba(4,9,18,0.72);
      opacity: 0; pointer-events: none; transition: opacity 0.18s ease;
      z-index: 2147483000;
    }
    .backdrop.open { opacity: 1; pointer-events: auto; }

    /* A centered, deeply-rounded card with a gold ring, like Nitro Type's
       own modals and the ring-bordered bubble cards on its garage/shop
       pages — not a flat full-bleed rectangle that blots out the game
       behind it. */
    .panel {
      position: fixed; inset: 0; margin: auto;
      width: min(97vw, 1360px); height: min(94vh, 940px);
      background: var(--nt-bg); color: var(--nt-text);
      font-family: var(--nt-font); font-size: 14px;
      border-radius: var(--nt-radius-lg);
      box-shadow: 0 0 0 2px var(--nt-gold) inset, 0 20px 60px rgba(0,0,0,0.55);
      opacity: 0; transform: scale(0.97); transition: opacity 0.18s ease, transform 0.18s ease;
      pointer-events: none;
      z-index: 2147483001;
      display: flex; flex-direction: column;
      overflow: hidden;
    }
    .panel.open { opacity: 1; transform: scale(1); pointer-events: auto; }

    .head {
      display: flex; flex-direction: column; gap: 14px;
      padding: 18px 32px 16px; flex-shrink: 0;
      background: linear-gradient(180deg, var(--nt-panel-raised), var(--nt-panel));
      border-bottom: 3px solid var(--nt-gold);
      border-radius: var(--nt-radius-lg) var(--nt-radius-lg) 0 0;
      position: sticky; top: 0; z-index: 2;
    }
    .head-top { display: flex; align-items: center; justify-content: space-between; }
    .head-top-actions { display: flex; align-items: center; gap: 2px; }
    .head-tabs { display: flex; align-items: center; justify-content: space-between; gap: 18px; flex-wrap: wrap; }
    .head-tabs-actions { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
    .logo {
      font-weight: 800; font-size: 20px; letter-spacing: 0.02em;
      font-style: italic; color: var(--nt-text);
    }
    .logo-bolt { color: var(--nt-gold); margin-right: 6px; font-style: normal; }
    .mode-switch { display: flex; background: var(--nt-bg); border-radius: 999px; padding: 3px; border: 1px solid var(--nt-line); }
    .mode-btn {
      border: none; background: transparent; color: var(--nt-dim);
      padding: 8px 18px; font-size: 13.5px; font-weight: 700; letter-spacing: 0.02em;
      border-radius: 999px; cursor: pointer; font-family: inherit;
    }
    .view-switch .view-btn { padding: 8px 16px; white-space: nowrap; }
    .mode-btn.active { background: var(--nt-red); color: #fff; box-shadow: var(--nt-bevel); }
    .tab-icon { display: inline-block; margin-right: 5px; opacity: 0.85; }
    .race-now-btn {
      display: inline-flex; align-items: center; gap: 5px; background: var(--nt-gold); color: #13223a;
      border-radius: 999px; padding: 8px 14px; font-size: 12.5px; font-weight: 800; text-decoration: none;
      box-shadow: var(--nt-bevel); font-family: inherit;
    }
    .race-now-btn:hover { filter: brightness(1.08); }
    .race-now-btn:active { box-shadow: inset 0 2px 0 rgba(0,0,0,0.2); }
    .my-team-btn {
      display: inline-flex; align-items: center; background: transparent; color: var(--nt-text);
      border: 1px solid var(--nt-line); border-radius: 999px; padding: 8px 14px;
      font-size: 12.5px; font-weight: 700; cursor: pointer; font-family: inherit;
    }
    .my-team-btn:hover { border-color: var(--nt-gold); color: var(--nt-gold); }
    .gear-btn { background: none; border: none; color: var(--nt-dim); font-size: 17px; cursor: pointer; padding: 2px 6px; }
    .gear-btn:hover { color: var(--nt-text); }
    .close-btn { background: none; border: none; color: var(--nt-dim); font-size: 20px; cursor: pointer; padding: 2px 8px; }
    .close-btn:hover { color: var(--nt-text); }

    .settings-wrap { position: relative; }
    .settings-pop {
      position: absolute; top: 100%; right: 0; margin-top: 8px; z-index: 3;
      width: 260px; background: var(--nt-panel); border: 1px solid var(--nt-line);
      border-radius: 10px; padding: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.5);
      display: flex; flex-direction: column; gap: 10px;
    }
    .settings-title { font-weight: 800; font-size: 14px; }
    .settings-note { font-size: 11.5px; color: var(--nt-dim); line-height: 1.5; }
    .settings-field { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--nt-dim); font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }
    .settings-field input {
      background: var(--nt-bg); border: 1px solid var(--nt-line); color: var(--nt-text);
      border-radius: 6px; padding: 8px 10px; font-size: 13px; font-family: inherit; text-transform: none;
    }
    .settings-field input:focus { outline: 2px solid var(--nt-red); outline-offset: -1px; }
    .theme-swatches { display: flex; gap: 8px; }
    .theme-swatch {
      width: 26px; height: 26px; border-radius: 50%; cursor: pointer; padding: 0;
      border: 2px solid transparent;
      background: linear-gradient(135deg, var(--swatch-red) 50%, var(--swatch-gold) 50%);
    }
    .theme-swatch.active { border-color: var(--nt-text); }
    .settings-save {
      background: var(--nt-red); color: #fff; border: none; border-radius: var(--nt-radius-sm);
      padding: 10px; font-size: 13px; font-weight: 800; cursor: pointer; font-family: inherit;
      box-shadow: var(--nt-bevel);
    }
    .settings-save:hover { filter: brightness(1.12); }
    .settings-save:active { box-shadow: inset 0 2px 0 rgba(0,0,0,0.2); }
    .settings-invite-btn {
      background: transparent; color: var(--nt-gold); border: 2px solid var(--nt-gold);
      border-radius: var(--nt-radius-sm); padding: 9px; font-size: 13px; font-weight: 800;
      cursor: pointer; font-family: inherit;
    }
    .settings-invite-btn:hover { background: rgba(240,199,94,0.12); }

    .content { width: 100%; max-width: 1280px; margin: 0 auto; padding: 32px 36px 48px; flex: 1; min-height: 0; overflow-y: auto; }
    .compare-inner { max-width: 760px; margin: 0 auto; }

    .inputs { display: grid; grid-template-columns: 1fr auto 1fr; align-items: end; gap: 16px; }
    .field { display: flex; flex-direction: column; gap: 6px; position: relative; }
    .field-label { font-size: 12px; color: var(--nt-dim); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
    .field input {
      background: var(--nt-panel); border: 1px solid var(--nt-line); color: var(--nt-text);
      border-radius: 8px; padding: 12px 14px; font-size: 16px; width: 100%; font-family: inherit;
    }
    .field input:focus { outline: 2px solid var(--nt-red); outline-offset: -1px; }
    .vs { color: var(--nt-gold); font-size: 15px; font-weight: 800; font-style: italic; padding-bottom: 13px; justify-self: center; }
    .compare-btn {
      grid-column: 1 / -1; margin-top: 10px; background: var(--nt-red); color: #fff;
      border: none; border-radius: var(--nt-radius); padding: 14px; font-size: 15px; font-weight: 800;
      letter-spacing: 0.03em; cursor: pointer; font-family: inherit;
      box-shadow: var(--nt-bevel);
    }
    .compare-btn:hover { filter: brightness(1.12); }
    .compare-btn:active { box-shadow: inset 0 2px 0 rgba(0,0,0,0.2); }
    .compare-btn:disabled { opacity: 0.5; cursor: default; }

    .find-link { align-self: flex-start; background: none; border: none; color: var(--nt-gold); font-size: 12px; font-weight: 700; padding: 3px 0 0; cursor: pointer; font-family: inherit; }
    .find-link:hover { text-decoration: underline; }

    .history-toggle {
      display: block; margin: 10px 0 0; background: none; border: none; color: var(--nt-dim);
      font-size: 12px; font-weight: 700; cursor: pointer; padding: 0; font-family: inherit;
    }
    .history-toggle:hover { color: var(--nt-gold); }
    .compare-history { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
    .history-entry {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      background: var(--nt-panel); border: 1px solid var(--nt-line); border-radius: 7px;
      padding: 9px 12px; font-size: 13px; color: var(--nt-text); cursor: pointer; font-family: inherit; text-align: left;
    }
    .history-entry:hover { border-color: var(--nt-gold); }
    .history-vs { color: var(--nt-dim); font-size: 11px; font-weight: 700; margin: 0 2px; }
    .history-when { color: var(--nt-dim); font-size: 11px; white-space: nowrap; }
    .history-clear {
      align-self: flex-end; background: none; border: none; color: var(--nt-dim); font-size: 11px;
      font-weight: 700; cursor: pointer; padding: 0 0 2px; font-family: inherit;
    }
    .history-clear:hover { color: #ff6b63; }
    .history-saved-note { font-size: 12px; color: var(--nt-dim); margin-bottom: 10px; padding: 8px 10px; background: var(--nt-panel); border-radius: 6px; }

    .finder { margin: 12px 0 0; padding: 14px; background: var(--nt-panel); border: 1px solid var(--nt-line); border-radius: 8px; display: flex; flex-direction: column; gap: 10px; }
    .finder-row { display: flex; gap: 8px; }
    .finder-team-input { flex: 1; background: var(--nt-bg); border: 1px solid var(--nt-line); color: var(--nt-text); border-radius: 6px; padding: 8px 10px; font-size: 14px; font-family: inherit; }
    .finder-load-btn { background: var(--nt-red-dim); color: var(--nt-gold); border: 1px solid var(--nt-line); border-radius: var(--nt-radius-sm); padding: 8px 14px; font-size: 13px; font-weight: 700; cursor: pointer; white-space: nowrap; font-family: inherit; }
    .finder-load-btn:hover { filter: brightness(1.2); }
    .finder-roster { background: var(--nt-bg); border: 1px solid var(--nt-line); color: var(--nt-text); border-radius: 6px; padding: 8px 10px; font-size: 14px; font-family: inherit; width: 100%; }
    .finder-status { font-size: 12px; color: var(--nt-dim); }
    .finder-status.error { color: #ff6b63; }

    .view[hidden] { display: none; }

    .teams-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; margin-bottom: 24px; flex-wrap: wrap; }
    .teams-title { font-size: 24px; font-weight: 800; margin: 0; font-style: italic; }
    .teams-count { color: var(--nt-dim); font-size: 13px; margin-top: 4px; }
    .teams-search {
      width: 260px; max-width: 100%; background: var(--nt-panel); border: 1px solid var(--nt-line); color: var(--nt-text);
      border-radius: 8px; padding: 11px 14px; font-size: 14px; font-family: inherit;
    }
    .teams-search:focus { outline: 2px solid var(--nt-red); outline-offset: -1px; }
    .teams-head-actions { display: flex; gap: 10px; align-items: center; }
    .team-finder-btn {
      background: var(--nt-gold); color: #13223a; border: none; border-radius: var(--nt-radius-sm);
      padding: 10px 14px; font-size: 13px; font-weight: 800; cursor: pointer; white-space: nowrap; font-family: inherit;
      box-shadow: var(--nt-bevel);
    }
    .team-finder-btn:hover { filter: brightness(1.2); }
    .team-finder-btn:disabled { opacity: 0.6; cursor: default; }
    .team-finder-note { font-size: 12px; color: var(--nt-gold); margin: -8px 0 16px; }
    .teams-filters {
      display: flex; align-items: end; gap: 14px; flex-wrap: wrap;
      margin-bottom: 18px; padding-bottom: 18px; border-bottom: 1px solid var(--nt-line);
    }
    .teams-filter { display: flex; flex-direction: column; gap: 5px; font-size: 11px; color: var(--nt-dim); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
    .teams-filter select, .teams-filter input {
      background: var(--nt-panel); border: 1px solid var(--nt-line); color: var(--nt-text);
      border-radius: 7px; padding: 8px 10px; font-size: 13px; font-family: inherit; width: 128px;
    }
    .teams-filter select:focus, .teams-filter input:focus { outline: 2px solid var(--nt-red); outline-offset: -1px; }
    .teams-filters-clear {
      background: none; border: 1px solid var(--nt-line); color: var(--nt-dim);
      border-radius: 7px; padding: 9px 14px; font-size: 12px; font-weight: 700; cursor: pointer; font-family: inherit;
    }
    .teams-filters-clear:hover { color: var(--nt-text); border-color: var(--nt-text); }
    .teams-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 14px; }
    .team-card {
      position: relative;
      text-align: left; cursor: pointer; background: var(--nt-panel); border: 1px solid var(--nt-line);
      border-left: 4px solid var(--team-color, var(--nt-gold)); border-radius: var(--nt-radius); padding: 16px 16px 12px;
      display: flex; flex-direction: column; gap: 5px; text-decoration: none; color: inherit;
    }
    .team-card:hover, .team-card:focus-visible { background: var(--nt-panel-raised); border-color: var(--nt-gold); outline: none; }
    .team-card-ranked { padding-left: 46px; }
    .team-card-rank {
      position: absolute; left: 14px; top: 16px; font-weight: 800; font-size: 15px; color: var(--nt-gold);
    }
    .team-card-watch {
      position: absolute; top: 10px; right: 10px; background: none; border: none;
      color: var(--nt-dim); font-size: 17px; line-height: 1; cursor: pointer; padding: 2px;
    }
    .team-card-watch:hover { color: var(--nt-gold); }
    .team-card-watch.active { color: var(--nt-gold); }
    .team-card-head { font-size: 15px; margin-bottom: 2px; padding-right: 20px; }
    .team-card-tag { font-weight: 800; margin-right: 2px; }
    .team-card-name { font-weight: 700; color: var(--nt-text); }
    .team-card-row { font-size: 12.5px; color: var(--nt-dim); }
    .team-card-row b { color: var(--nt-text); font-weight: 700; }
    .team-card-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--nt-line); }
    .team-card-link { color: var(--nt-gold); font-size: 12px; font-weight: 700; }
    .team-card-synced { font-size: 10.5px; color: var(--nt-dim); opacity: 0.75; white-space: nowrap; }
    .teams-empty { grid-column: 1 / -1; font-size: 13px; color: var(--nt-dim); padding: 20px 4px; line-height: 1.6; }
    .empty-action { background: none; border: none; color: var(--nt-gold); font-size: 13px; font-weight: 700; cursor: pointer; padding: 0; font-family: inherit; }
    .empty-action:hover { text-decoration: underline; }

    .racers-dash-list { display: flex; flex-direction: column; gap: 6px; }
    .racer-dash-head, .racer-dash-row {
      display: grid; grid-template-columns: 2fr 1fr 1fr 1fr 28px; gap: 10px; align-items: center;
      padding: 10px 12px; border-radius: var(--nt-radius-sm); font-size: 13px;
    }
    .racer-dash-head { color: var(--nt-dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 700; padding-bottom: 6px; }
    .racer-dash-row { background: var(--nt-panel); border: 1px solid var(--nt-line); }
    .racer-dash-row-error { color: var(--nt-dim); }
    .racer-dash-name { font-weight: 700; }
    .racer-dash-rank { color: var(--nt-gold); font-weight: 800; margin-right: 6px; }
    .racer-dash-sort-field { margin: 0 0 10px; max-width: 220px; }
    .racer-dash-sort-field select {
      background: var(--nt-bg); border: 1px solid var(--nt-line); color: var(--nt-text);
      border-radius: 6px; padding: 6px 8px; font-size: 12px; font-family: inherit; text-transform: none;
    }
    .racer-dash-tag { color: var(--nt-gold); font-weight: 700; font-size: 11px; }
    .racer-dash-remove { background: none; border: none; color: var(--nt-dim); cursor: pointer; font-size: 13px; padding: 2px; }
    .racer-dash-remove:hover { color: #ff6b63; }
    .racer-dash-head.racer-lb-row, .racer-dash-row.racer-lb-row { grid-template-columns: 36px 2fr 70px 90px 110px; }
    .racer-leaderboard-pagination {
      display: flex; align-items: center; justify-content: center; gap: 14px;
      margin-top: 12px; font-size: 12px; color: var(--nt-dim); font-weight: 700;
    }

    .team-detail-back {
      background: none; border: none; color: var(--nt-dim); font-size: 13px; font-weight: 700;
      cursor: pointer; padding: 0 0 16px; font-family: inherit;
    }
    .team-detail-back:hover { color: var(--nt-gold); }
    .team-detail-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
    .team-detail-tag { font-size: 20px; font-weight: 800; margin-right: 6px; }
    .team-detail-name { font-size: 18px; font-weight: 700; }
    .team-detail-stats { display: flex; gap: 20px; flex-wrap: wrap; color: var(--nt-dim); font-size: 13px; margin-bottom: 18px; padding-bottom: 14px; border-bottom: 1px solid var(--nt-line); }
    .team-detail-stats b { color: var(--nt-text); font-weight: 700; }
    .team-detail-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .team-detail-table th { text-align: left; color: var(--nt-dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 700; padding: 0 10px 8px; border-bottom: 1px solid var(--nt-line); }
    .team-detail-table td { padding: 7px 10px; border-bottom: 1px solid var(--nt-line); }
    .team-detail-track { background: none; border: none; color: var(--nt-dim); font-size: 15px; line-height: 1; cursor: pointer; padding: 2px; }
    .team-detail-track:hover { color: var(--nt-gold); }
    .team-detail-track.active { color: var(--nt-gold); }
    .team-detail-trend-up { color: #6fcf6f; }
    .team-detail-trend-down { color: #ff7a6e; }
    .team-detail-heatmap { margin-bottom: 18px; }
    .team-detail-heatmap-title { font-size: 11px; color: var(--nt-dim); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 700; margin-bottom: 6px; }
    .team-detail-heatmap-empty { font-size: 12px; color: var(--nt-dim); }
    .heat-row { display: grid; grid-template-columns: repeat(24, 1fr); gap: 2px; }
    .heat-cell {
      height: 18px; border-radius: 3px;
      background: color-mix(in srgb, var(--nt-gold) calc(var(--heat) * 100%), var(--nt-panel));
    }
    .heat-row-labels { display: flex; justify-content: space-between; font-size: 10px; color: var(--nt-dim); margin-top: 4px; }
    .team-detail-external { display: inline-block; margin-top: 16px; color: var(--nt-gold); font-size: 12.5px; font-weight: 700; text-decoration: none; }
    .team-detail-external:hover { text-decoration: underline; }

    .status { padding: 16px 0; color: var(--nt-dim); font-size: 15px; }
    .status.error { color: #ff6b63; }
    .result { padding: 24px 0 0; }
    .names { display: grid; grid-template-columns: 1fr auto 1fr; gap: 12px; align-items: center; padding: 0 0 16px; }
    .name-cell { font-weight: 800; font-size: 20px; overflow-wrap: anywhere; }
    .name-cell.a { text-align: left; }
    .name-cell.b { text-align: right; }
    .names .vs-mid { color: var(--nt-gold); font-size: 13px; font-weight: 800; font-style: italic; }
    .section-title {
      color: var(--nt-gold); font-size: 12px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.06em; margin: 22px 0 10px; border-top: 1px solid var(--nt-line); padding-top: 16px;
    }
    .stat-row { display: grid; grid-template-columns: 1fr 120px 1fr; grid-template-rows: auto auto; align-items: center; gap: 2px 12px; padding: 7px 0 9px; background: var(--nt-panel); border-radius: 6px; margin-bottom: 2px; }
    .stat-val { font-weight: 800; font-variant-numeric: tabular-nums; font-size: 15px; padding: 0 14px; }
    .stat-val.a { text-align: left; }
    .stat-val.b { text-align: right; }
    .stat-val.win { color: var(--nt-gold); }
    .stat-label { text-align: center; color: var(--nt-dim); font-size: 12px; font-weight: 600; }
    .trend-note { font-size: 13px; color: var(--nt-dim); line-height: 1.6; padding: 10px 14px; background: var(--nt-panel); border-radius: 6px; margin-top: 10px; }
    .trend-note b { color: var(--nt-gold); }

    /* Lead bar under each stat row — same "who's ahead" read as StarTrack's
       Showdown tier bars, built from the single snapshot we fetch. */
    .stat-bar { grid-column: 1 / -1; display: flex; height: 5px; border-radius: 3px; overflow: hidden; margin: 0 14px; background: var(--nt-line); }
    .stat-bar-a { background: var(--nt-gold); }
    .stat-bar-b { background: var(--nt-red); }

    /* Duel-score strip — tallies how many rows below each side won, the
       same "A 10 – 5 B" summary StarTrack opens its Showdown page with. */
    .duel-score { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 14px; padding: 14px 0 6px; }
    .duel-val { font-size: 34px; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--nt-dim); }
    .duel-val.a { text-align: right; }
    .duel-val.b { text-align: left; }
    .duel-val.lead { color: var(--nt-gold); }
    .duel-mid { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: var(--nt-dim); text-transform: uppercase; }
  `;

  const { root } = buildPanel();
  panelApi = wirePanel(root);
})();
