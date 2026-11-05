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
    // badge on the fab/nav tab so there's a signal without opening it.
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
    const MAX_RIVALS = 5;
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

    return { list, getGoal, getStreak, setGoal, deltaSince, subscribe };
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

  const BADGE_CSS = `
    :host, * { box-sizing: border-box; }
    :host {
      --nt-panel: #13223a; --nt-line: #24395c; --nt-text: #f0f4fa;
      --nt-dim: #8fa3bf; --nt-gold: #f0c75e;
      --nt-font: "Manrope", "Segoe UI", Roboto, system-ui, sans-serif;
      all: initial;
    }
    .badge {
      position: fixed; z-index: 2147482998; right: 24px; bottom: 192px;
      display: block; width: 236px; text-decoration: none; cursor: pointer;
      background: var(--nt-panel); border: 1px solid var(--nt-line); border-left: 4px solid var(--nt-gold);
      border-radius: 10px; padding: 14px 16px; color: var(--nt-text);
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
      const [delta, goal, streak] = await Promise.all([Progress.deltaSince(7), Progress.getGoal(), Progress.getStreak()]);
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
      badge.innerHTML = `
        <div class="badge-head">Your progress</div>
        <div class="badge-verdict">${verdict}</div>
        ${deltaLine}
        ${goalLine}
        <div class="badge-foot">Recorded automatically in the background</div>`;
      badge.hidden = false;
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
    const anchor = document.querySelector('a[href="/leaderboards"]');
    const li = anchor && anchor.closest("li");
    if (!li || !li.parentNode) return;

    const clone = li.cloneNode(true);
    clone.id = NAV_TAB_ID;
    const link = clone.querySelector("a") || clone;
    link.removeAttribute("href");
    link.style.cursor = "pointer";
    link.setAttribute("role", "button");
    // Keep whatever wrapper markup NT uses, just swap the visible label —
    // as its own text node plus a badge span, so the unseen-teams counter
    // (see updateNavBadge below) has somewhere to live without us having
    // to re-clone or re-style NT's own nav markup.
    const labelNode = link.querySelector("span") || link;
    labelNode.textContent = "";
    labelNode.append("⚡ TypeTrack");
    const badge = document.createElement("span");
    badge.id = "ntcmp-nav-badge";
    badge.style.cssText =
      "display:inline-block;margin-left:6px;min-width:16px;padding:1px 5px;border-radius:9px;" +
      "background:#f0c75e;color:#13223a;font-size:11px;font-weight:800;line-height:1.4;text-align:center;";
    badge.hidden = true;
    labelNode.append(badge);
    link.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (panelApi) panelApi.toggle();
    });

    li.parentNode.insertBefore(clone, li.nextSibling);
    updateNavBadge(TeamDirectory.unseenCount());
  }

  function updateNavBadge(n) {
    const badge = document.getElementById("ntcmp-nav-badge");
    if (!badge) return;
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.hidden = n === 0;
  }
  TeamDirectory.subscribe(() => updateNavBadge(TeamDirectory.unseenCount()));

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
      <button id="fab" class="fab" aria-label="Open TypeTrack" title="TypeTrack — compare &amp; browse teams">
        <span class="fab-bolt">⚡</span>TypeTrack<span class="fab-streak" id="fab-streak" hidden></span><span class="fab-badge" id="fab-badge" hidden></span>
      </button>
      <div class="backdrop" id="backdrop"></div>
      <div class="panel" id="panel">
        <header class="head">
          <span class="logo"><span class="logo-bolt">⚡</span>TYPETRACK</span>
          <div class="head-right">
            <div class="mode-switch view-switch">
              <button class="mode-btn view-btn active" data-view="compare" type="button">Compare</button>
              <button class="mode-btn view-btn" data-view="teams" type="button">Teams</button>
            </div>
            <button class="gear-btn" id="gear-btn" aria-label="Settings" title="Set your team &amp; racer">⚙</button>
            <button class="close-btn" id="close-btn" aria-label="Close">✕</button>
          </div>
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
            <button type="button" class="settings-save" id="settings-save">Save</button>
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
              <div id="result" class="result" hidden></div>
            </div>
          </div>

          <div id="view-teams" class="view" hidden>
            <div class="teams-head">
              <div class="teams-heading">
                <h2 class="teams-title">Browse teams</h2>
                <div class="teams-count" id="teams-count">0 teams tracked</div>
              </div>
              <input type="text" id="teams-search" class="teams-search" placeholder="Search teams…" autocomplete="off" spellcheck="false" />
            </div>
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
        </div>
      </div>`;

    return { host, root };
  }

  function wirePanel(root) {
    const state = { mode: "team", open: false };

    const els = {
      fab: root.getElementById("fab"),
      fabBadge: root.getElementById("fab-badge"),
      fabStreak: root.getElementById("fab-streak"),
      backdrop: root.getElementById("backdrop"),
      panel: root.getElementById("panel"),
      gearBtn: root.getElementById("gear-btn"),
      settingsPop: root.getElementById("settings-pop"),
      settingsMyTeam: root.getElementById("settings-my-team"),
      settingsMyRacer: root.getElementById("settings-my-racer"),
      settingsDailyGoal: root.getElementById("settings-daily-goal"),
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
      teamsSort: root.getElementById("teams-sort"),
      teamsMaxSpeed: root.getElementById("teams-max-speed"),
      teamsMaxRaces: root.getElementById("teams-max-races"),
      teamsMinMembers: root.getElementById("teams-min-members"),
      teamsFiltersClear: root.getElementById("teams-filters-clear"),
      teamsList: root.getElementById("teams-list"),
      teamsCount: root.getElementById("teams-count"),
      knownTeamsList: root.getElementById("known-teams"),
      form: root.getElementById("compare-form"),
      btn: root.querySelector(".compare-btn"),
      status: root.getElementById("status"),
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
    }
    fillSettingsInputs(Settings.get());
    Settings.subscribe(fillSettingsInputs);
    els.settingsSave.addEventListener("click", async () => {
      await Settings.setMyTeam(els.settingsMyTeam.value);
      await Settings.setMyRacer(els.settingsMyRacer.value);
      await Progress.setGoal(els.settingsDailyGoal.value);
      els.settingsPop.hidden = true;
    });

    // Site-wide streak badge on the fab itself — not just inside the panel —
    // so a streak stays visible without opening TypeTrack at all.
    async function updateStreakBadge() {
      const streak = await Progress.getStreak();
      els.fabStreak.textContent = `🔥${streak}`;
      els.fabStreak.hidden = !streak;
    }
    updateStreakBadge();
    Progress.subscribe(updateStreakBadge);

    // Unseen-teams counter — a small badge on the fab showing how many
    // teams (local finds + shared-list syncs) have shown up since the
    // Teams tab was last actually opened.
    function updateFabBadge() {
      const n = TeamDirectory.unseenCount();
      els.fabBadge.textContent = n > 99 ? "99+" : String(n);
      els.fabBadge.hidden = n === 0;
    }
    updateFabBadge();
    TeamDirectory.subscribe(updateFabBadge);

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
      els.viewBtns.forEach((b) => b.classList.toggle("active", b.dataset.view === view));
      els.viewCompare.hidden = view !== "compare";
      els.viewTeams.hidden = view !== "teams";
      if (view === "teams") {
        renderTeamsList();
        els.teamsSearch.focus();
        TeamDirectory.markSeen();
      }
    }
    els.viewBtns.forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

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
      els.teamsCount.textContent =
        (filtered ? `${items.length} of ${all.length} teams tracked` : `${all.length} teams tracked`) +
        (watchedCount ? ` · ${watchedCount} watched` : "");
      els.teamsList.innerHTML = items.length
        ? items
            .map((t) => {
              const color = t.color ? `#${t.color}` : "var(--nt-gold)";
              const watching = WatchList.has(t.tag);
              return `
                <a class="team-card" href="https://www.nitrotype.com/team/${encodeURIComponent(t.tag)}" target="_blank" rel="noopener" data-tag="${escapeHtml(t.tag)}" style="--team-color:${color}">
                  <button type="button" class="team-card-watch${watching ? " active" : ""}" data-tag="${escapeHtml(t.tag)}" title="${watching ? "Stop watching for changes" : "Watch for changes (captain, requirements, member swings)"}">${watching ? "★" : "☆"}</button>
                  <div class="team-card-head"><span class="team-card-tag" style="color:${color}">[${escapeHtml(t.tag)}]</span> <span class="team-card-name">${escapeHtml(t.name)}</span></div>
                  <div class="team-card-row">Captain: <b>${escapeHtml(t.captain || "—")}</b></div>
                  <div class="team-card-row">Members: <b>${t.members ?? "—"}</b> · Formed: <b>${fmtFormed(t.formed)}</b></div>
                  <div class="team-card-row">Min: <b>${t.minRaces ?? 0} races / ${t.minSpeed ?? 0} wpm</b></div>
                  <div class="team-card-foot">
                    <span class="team-card-link">View on Nitro Type</span>
                    ${t.syncedAt ? `<span class="team-card-synced">Synced ${fmtSynced(t.syncedAt)}</span>` : ""}
                  </div>
                </a>`;
            })
            .join("")
        : `<div class="teams-empty">No teams match yet — keep comparing or browsing teams on nitrotype.com and this list grows.</div>`;
    }
    [els.teamsSearch, els.teamsMaxSpeed, els.teamsMaxRaces, els.teamsMinMembers].forEach((el) =>
      el.addEventListener("input", renderTeamsList)
    );
    els.teamsSort.addEventListener("change", renderTeamsList);
    // Event delegation: the star buttons get wiped and recreated on every
    // render, so listen on the stable grid container instead of each card.
    els.teamsList.addEventListener("click", (e) => {
      const btn = e.target.closest(".team-card-watch");
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      WatchList.toggle(btn.dataset.tag);
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
        const [dataA, dataB] = await Promise.all([fetchFn(a), fetchFn(b)]);
        setStatus("");
        els.result.innerHTML = state.mode === "team" ? renderTeams(dataA, dataB) : renderRacers(dataA, dataB);
        els.result.hidden = false;
        if (state.mode === "team") {
          TeamDirectory.remember(dataA);
          TeamDirectory.remember(dataB);
        }
      } catch (err) {
        setStatus(err.message || "Something went wrong.", true);
      } finally {
        els.btn.disabled = false;
      }
    });

    function open() {
      state.open = true;
      els.panel.classList.add("open");
      els.backdrop.classList.add("open");
      // Prefill side A from the current page, same spirit as before.
      const teamMatch = location.pathname.match(/^\/team\/([^/?#]+)/i);
      const racerMatch = location.pathname.match(/^\/racer\/([^/?#]+)/i);
      if (teamMatch && !els.inputA.value) {
        setMode("team");
        els.inputA.value = decodeURIComponent(teamMatch[1]);
      } else if (racerMatch && !els.inputA.value) {
        setMode("racer");
        els.inputA.value = decodeURIComponent(racerMatch[1]);
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

    els.fab.addEventListener("click", toggle);
    els.closeBtn.addEventListener("click", close);
    els.backdrop.addEventListener("click", close);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.open) close();
    });

    setMode("team");
    setView("compare");

    return { open, close, toggle, compareTeams, compareRacers };
  }

  const PANEL_CSS = `
    :host, * { box-sizing: border-box; }
    [hidden] { display: none !important; }

    /* Palette pulled from Nitro Type's own site: deep navy backgrounds,
       its signature red, and the gold it uses for Legend/trophy accents. */
    :host {
      --nt-bg: #0b1626;
      --nt-panel: #13223a;
      --nt-panel-raised: #1a2d4a;
      --nt-line: #24395c;
      --nt-text: #f0f4fa;
      --nt-dim: #8fa3bf;
      --nt-red: #e2231a;
      --nt-red-dim: #3a1414;
      --nt-gold: #f0c75e;
      --nt-font: "Manrope", "Segoe UI", Roboto, system-ui, sans-serif;
    }

    .fab {
      position: fixed; right: 24px; bottom: 116px;
      display: flex; align-items: center; gap: 8px;
      padding: 13px 20px; border-radius: 14px;
      background: var(--nt-red); color: #fff; border: 2px solid #ff6b63;
      font-family: var(--nt-font); font-size: 15px; font-weight: 700;
      cursor: pointer; white-space: nowrap;
      box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      z-index: 2147482999;
    }
    .fab:hover { filter: brightness(1.1); transform: scale(1.05); }
    .fab-bolt { font-size: 18px; }
    .fab-badge {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
      background: var(--nt-gold); color: #13223a; font-size: 11px; font-weight: 800;
    }
    .fab-streak {
      display: inline-flex; align-items: center; font-size: 12px; font-weight: 800;
    }

    .backdrop {
      position: fixed; inset: 0; background: rgba(4,9,18,0.7);
      opacity: 0; pointer-events: none; transition: opacity 0.18s ease;
      z-index: 2147483000;
    }
    .backdrop.open { opacity: 1; pointer-events: auto; }

    .panel {
      position: fixed; inset: 0;
      background: var(--nt-bg); color: var(--nt-text);
      font-family: var(--nt-font); font-size: 14px;
      opacity: 0; transform: scale(0.98); transition: opacity 0.18s ease, transform 0.18s ease;
      pointer-events: none;
      z-index: 2147483001;
      display: flex; flex-direction: column;
      overflow-y: auto;
    }
    .panel.open { opacity: 1; transform: scale(1); pointer-events: auto; }

    .head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 18px 28px; border-bottom: 2px solid var(--nt-red);
      background: var(--nt-panel); flex-shrink: 0;
      position: sticky; top: 0; z-index: 2;
    }
    .logo {
      font-weight: 800; font-size: 20px; letter-spacing: 0.03em;
      font-style: italic; color: var(--nt-text);
    }
    .logo-bolt { color: var(--nt-gold); margin-right: 6px; font-style: normal; }
    .head-right { display: flex; align-items: center; gap: 14px; }
    .mode-switch { display: flex; background: var(--nt-bg); border-radius: 8px; padding: 3px; border: 1px solid var(--nt-line); }
    .mode-btn {
      border: none; background: transparent; color: var(--nt-dim);
      padding: 7px 16px; font-size: 13px; font-weight: 700; letter-spacing: 0.02em;
      border-radius: 6px; cursor: pointer; font-family: inherit;
    }
    .mode-btn.active { background: var(--nt-red); color: #fff; }
    .gear-btn { background: none; border: none; color: var(--nt-dim); font-size: 17px; cursor: pointer; padding: 2px 6px; }
    .gear-btn:hover { color: var(--nt-text); }
    .close-btn { background: none; border: none; color: var(--nt-dim); font-size: 20px; cursor: pointer; padding: 2px 8px; }
    .close-btn:hover { color: var(--nt-text); }

    .settings-pop {
      position: absolute; top: 100%; right: 28px; margin-top: 8px; z-index: 3;
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
    .settings-save {
      background: var(--nt-red); color: #fff; border: none; border-radius: 7px;
      padding: 9px; font-size: 13px; font-weight: 800; cursor: pointer; font-family: inherit;
    }
    .settings-save:hover { filter: brightness(1.12); }

    .content { width: 100%; max-width: 1180px; margin: 0 auto; padding: 32px 24px 60px; flex: 1; }
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
      border: none; border-radius: 8px; padding: 14px; font-size: 15px; font-weight: 800;
      letter-spacing: 0.03em; cursor: pointer; font-family: inherit;
    }
    .compare-btn:hover { filter: brightness(1.12); }
    .compare-btn:disabled { opacity: 0.5; cursor: default; }

    .find-link { align-self: flex-start; background: none; border: none; color: var(--nt-gold); font-size: 12px; font-weight: 700; padding: 3px 0 0; cursor: pointer; font-family: inherit; }
    .find-link:hover { text-decoration: underline; }

    .finder { margin: 12px 0 0; padding: 14px; background: var(--nt-panel); border: 1px solid var(--nt-line); border-radius: 8px; display: flex; flex-direction: column; gap: 10px; }
    .finder-row { display: flex; gap: 8px; }
    .finder-team-input { flex: 1; background: var(--nt-bg); border: 1px solid var(--nt-line); color: var(--nt-text); border-radius: 6px; padding: 8px 10px; font-size: 14px; font-family: inherit; }
    .finder-load-btn { background: var(--nt-red-dim); color: var(--nt-gold); border: 1px solid var(--nt-line); border-radius: 6px; padding: 8px 14px; font-size: 13px; font-weight: 700; cursor: pointer; white-space: nowrap; font-family: inherit; }
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
      border-left: 4px solid var(--team-color, var(--nt-gold)); border-radius: 8px; padding: 16px 16px 12px;
      display: flex; flex-direction: column; gap: 5px; text-decoration: none; color: inherit;
    }
    .team-card:hover, .team-card:focus-visible { background: var(--nt-panel-raised); border-color: var(--nt-gold); outline: none; }
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
