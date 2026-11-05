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
    const subscribers = [];

    function storageGet(key) {
      return new Promise((resolve) => chrome.storage.local.get([key], (r) => resolve(r[key])));
    }
    function storageSet(obj) {
      return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
    }

    async function load() {
      teams = (await storageGet("ntcmp:knownTeams")) || [];
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
        }
      };
      // A handful of workers at a time — fast enough to fill in over a
      // few seconds, gentle enough not to look like hammering NT's API.
      await Promise.all(Array.from({ length: 4 }, worker));
    }

    async function captureFromPath(pathname) {
      const m = pathname.match(/^\/team\/([^/?#]+)/i);
      if (!m) return;
      const tag = decodeURIComponent(m[1]).toUpperCase();
      try {
        const team = await NT.fetchTeam(tag);
        await remember(team);
      } catch (e) {
        // Not fatal — just don't add it.
      }
    }

    load();
    return { remember, mergeRemote, list, subscribe, seedOnce, captureFromPath };
  })();

  TeamDirectory.seedOnce();
  SharedTeams.pullAll().then((remote) => TeamDirectory.mergeRemote(remote));

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
    // Keep whatever wrapper markup NT uses, just swap the visible label.
    const labelNode = link.querySelector("span") || link;
    labelNode.textContent = "⚡ TypeTrack";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (panelApi) panelApi.toggle();
    });

    li.parentNode.insertBefore(clone, li.nextSibling);
  }

  let lastCapturedPath = null;
  function onPossibleNavigation() {
    ensureNavTab();
    if (location.pathname !== lastCapturedPath) {
      lastCapturedPath = location.pathname;
      TeamDirectory.captureFromPath(location.pathname);
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

  // Manrope — the same clean, squared-but-flowing geometric sans StarTrack
  // itself uses. Self-hosted in the extension (one variable-weight file,
  // rather than pulled from Google Fonts at runtime) so it always loads
  // regardless of nitrotype.com's own CSP.
  const FONT_FACE_CSS = `
    @font-face {
      font-family: "Manrope";
      font-weight: 200 800;
      font-style: normal;
      src: url("${chrome.runtime.getURL("fonts/Manrope-Variable.ttf")}") format("truetype-variations");
    }
  `;

  function buildPanel() {
    const host = document.createElement("div");
    host.id = "ntcmp-host";
    host.style.all = "initial";
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });

    root.innerHTML = `
      <style>${FONT_FACE_CSS}${PANEL_CSS}</style>
      <button id="fab" class="fab" aria-label="Open TypeTrack" title="TypeTrack — compare &amp; browse teams"><span class="fab-bolt">⚡</span>TypeTrack</button>
      <div class="backdrop" id="backdrop"></div>
      <div class="panel" id="panel">
        <header class="head">
          <span class="logo"><span class="logo-bolt">⚡</span>TYPETRACK</span>
          <div class="head-right">
            <div class="mode-switch view-switch">
              <button class="mode-btn view-btn active" data-view="compare" type="button">Compare</button>
              <button class="mode-btn view-btn" data-view="teams" type="button">Teams</button>
            </div>
            <button class="close-btn" id="close-btn" aria-label="Close">✕</button>
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
      backdrop: root.getElementById("backdrop"),
      panel: root.getElementById("panel"),
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
      els.teamsCount.textContent = filtered ? `${items.length} of ${all.length} teams tracked` : `${all.length} teams tracked`;
      els.teamsList.innerHTML = items.length
        ? items
            .map((t) => {
              const color = t.color ? `#${t.color}` : "var(--nt-gold)";
              return `
                <a class="team-card" href="https://www.nitrotype.com/team/${encodeURIComponent(t.tag)}" target="_blank" rel="noopener" data-tag="${escapeHtml(t.tag)}" style="--team-color:${color}">
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

    els.fab.addEventListener("click", toggle);
    els.closeBtn.addEventListener("click", close);
    els.backdrop.addEventListener("click", close);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.open) close();
    });

    setMode("team");
    setView("compare");

    return { open, close, toggle };
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
    .close-btn { background: none; border: none; color: var(--nt-dim); font-size: 20px; cursor: pointer; padding: 2px 8px; }
    .close-btn:hover { color: var(--nt-text); }

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
      text-align: left; cursor: pointer; background: var(--nt-panel); border: 1px solid var(--nt-line);
      border-left: 4px solid var(--team-color, var(--nt-gold)); border-radius: 8px; padding: 16px 16px 12px;
      display: flex; flex-direction: column; gap: 5px; text-decoration: none; color: inherit;
    }
    .team-card:hover, .team-card:focus-visible { background: var(--nt-panel-raised); border-color: var(--nt-gold); outline: none; }
    .team-card-head { font-size: 15px; margin-bottom: 2px; }
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
