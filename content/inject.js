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
  // Nav tab injection (clones a real nav <li> so it inherits NT's own
  // styling exactly, rather than us guessing their class names).
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
    labelNode.textContent = "⚡ Head-to-Head";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (panelApi) panelApi.toggle();
    });

    li.parentNode.insertBefore(clone, li.nextSibling);
  }

  const navObserver = new MutationObserver(() => ensureNavTab());
  navObserver.observe(document.documentElement, { childList: true, subtree: true });
  ensureNavTab();
  setInterval(ensureNavTab, 2000); // cheap safety net for SPA re-renders the observer might miss

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
      <style>${PANEL_CSS}</style>
      <button id="fab" class="fab" aria-label="Open Head-to-Head" title="Head-to-Head comparator">⚡</button>
      <div class="backdrop" id="backdrop"></div>
      <div class="panel" id="panel">
        <header class="head">
          <span class="logo">⚡ Head-to-Head</span>
          <div class="head-right">
            <div class="mode-switch">
              <button class="mode-btn active" data-mode="team" type="button">Teams</button>
              <button class="mode-btn" data-mode="racer" type="button">Racers</button>
            </div>
            <button class="close-btn" id="close-btn" aria-label="Close">✕</button>
          </div>
        </header>

        <form id="compare-form" class="inputs">
          <label class="field">
            <span class="field-label" id="label-a">Team A tag</span>
            <input type="text" id="input-a" list="known-teams" autocomplete="off" spellcheck="false" />
            <button type="button" class="find-link" id="find-a" hidden>Find by name</button>
          </label>
          <span class="vs">vs</span>
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
      </div>`;

    return { host, root };
  }

  function wirePanel(root) {
    const state = { mode: "team", knownTeams: [], open: false };

    const els = {
      fab: root.getElementById("fab"),
      backdrop: root.getElementById("backdrop"),
      panel: root.getElementById("panel"),
      closeBtn: root.getElementById("close-btn"),
      modeBtns: root.querySelectorAll(".mode-btn"),
      labelA: root.getElementById("label-a"),
      labelB: root.getElementById("label-b"),
      inputA: root.getElementById("input-a"),
      inputB: root.getElementById("input-b"),
      findA: root.getElementById("find-a"),
      findB: root.getElementById("find-b"),
      finderA: root.getElementById("finder-a"),
      finderB: root.getElementById("finder-b"),
      knownTeamsList: root.getElementById("known-teams"),
      form: root.getElementById("compare-form"),
      btn: root.querySelector(".compare-btn"),
      status: root.getElementById("status"),
      result: root.getElementById("result"),
    };

    function storageGet(key) {
      return new Promise((resolve) => chrome.storage.local.get([key], (r) => resolve(r[key])));
    }
    function storageSet(obj) {
      return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
    }

    async function loadKnownTeams() {
      state.knownTeams = (await storageGet("ntcmp:knownTeams")) || [];
      renderKnownTeamsDatalist();
    }

    async function rememberTeam(tag, name) {
      const clean = tag.trim().toUpperCase();
      const idx = state.knownTeams.findIndex((t) => t.tag === clean);
      if (idx >= 0) state.knownTeams[idx] = { tag: clean, name: name || state.knownTeams[idx].name };
      else state.knownTeams.unshift({ tag: clean, name: name || clean });
      state.knownTeams = state.knownTeams.slice(0, 60);
      await storageSet({ "ntcmp:knownTeams": state.knownTeams });
      renderKnownTeamsDatalist();
    }

    function renderKnownTeamsDatalist() {
      els.knownTeamsList.innerHTML = state.knownTeams
        .map((t) => `<option value="${t.tag}">${t.tag} — ${escapeHtml(t.name)}</option>`)
        .join("");
    }

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
          await rememberTeam(team.tag, team.name);
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

    function statRow(label, aVal, bVal, { higherIsBetter = true, suffix = "", noWin = false } = {}) {
      const an = typeof aVal === "number" ? aVal : parseFloat(aVal);
      const bn = typeof bVal === "number" ? bVal : parseFloat(bVal);
      let aWin = false, bWin = false;
      if (!noWin && !Number.isNaN(an) && !Number.isNaN(bn) && an !== bn) {
        if (higherIsBetter ? an > bn : an < bn) aWin = true;
        else bWin = true;
      }
      return `
        <div class="stat-row">
          <span class="stat-val a ${aWin ? "win" : ""}">${aVal ?? "—"}${suffix}</span>
          <span class="stat-label">${label}</span>
          <span class="stat-val b ${bWin ? "win" : ""}">${bVal ?? "—"}${suffix}</span>
        </div>`;
    }

    function renderTeams(a, b) {
      const boardRows = (boardName, title) => {
        const ba = a.boards[boardName];
        const bb = b.boards[boardName];
        if (!ba && !bb) return "";
        return `
          <div class="section-title">${title}</div>
          ${statRow("Races", ba?.races ?? 0, bb?.races ?? 0)}
          ${statRow("Avg speed", ba?.speed ?? 0, bb?.speed ?? 0, { suffix: " wpm" })}
          ${statRow("Accuracy", ba?.accuracy ?? 0, bb?.accuracy ?? 0, { suffix: "%" })}
          ${statRow("Points", ba?.points ?? 0, bb?.points ?? 0)}`;
      };
      const paceLine = (t) =>
        t.trend.minRaces
          ? `<b>${t.trend.onPaceCount}/${t.trend.eligibleCount}</b> members on pace for the ${t.trend.minRaces}-race weekly requirement`
          : `No weekly race requirement set`;
      return `
        <div class="names">
          <span class="name-cell a">[${a.tag}] ${escapeHtml(a.name)}</span>
          <span class="vs-mid">vs</span>
          <span class="name-cell b">${escapeHtml(b.name)} [${b.tag}]</span>
        </div>
        <div class="section-title">Roster</div>
        ${statRow("Members", a.memberCount, b.memberCount)}
        ${statRow("Active %", a.trend.activePercent, b.trend.activePercent, { suffix: "%" })}
        ${statRow("Active (≤3d)", a.trend.activeRecentlyCount, b.trend.activeRecentlyCount)}
        ${boardRows("alltime", "All-time")}
        ${boardRows("season", "This season")}
        ${boardRows("daily", "Today")}
        <div class="section-title">This week</div>
        <div class="trend-note">${a.tag}: ${paceLine(a)}</div>
        <div class="trend-note">${b.tag}: ${paceLine(b)}</div>`;
    }

    function renderRacers(a, b) {
      const fmtAge = (days) => {
        if (days == null) return "—";
        if (days < 30) return `${days}d`;
        if (days < 365) return `${Math.round(days / 30)}mo`;
        return `${(days / 365).toFixed(1)}yr`;
      };
      return `
        <div class="names">
          <span class="name-cell a">${escapeHtml(a.displayName)}${a.tag ? ` [${a.tag}]` : ""}</span>
          <span class="vs-mid">vs</span>
          <span class="name-cell b">${escapeHtml(b.displayName)}${b.tag ? ` [${b.tag}]` : ""}</span>
        </div>
        <div class="section-title">Profile</div>
        ${statRow("Level", a.level, b.level)}
        ${statRow("Lifetime races", a.racesPlayed, b.racesPlayed)}
        ${statRow("Avg speed", a.avgSpeed, b.avgSpeed, { suffix: " wpm" })}
        ${statRow("Top speed", a.highestSpeed, b.highestSpeed, { suffix: " wpm" })}
        <div class="section-title">Extras</div>
        ${statRow("League tier", a.leagueTier, b.leagueTier)}
        ${statRow("Membership", a.membership, b.membership, { noWin: true })}
        ${statRow("Longest session", a.longestSession, b.longestSession, { suffix: " min" })}
        ${statRow("Racing since", fmtAge(a.accountAgeDays), fmtAge(b.accountAgeDays), { noWin: true })}
        <div class="trend-note">Nitro Type's racer pages no longer expose a season/daily breakdown, so this is lifetime data only — not a recent-form snapshot.</div>`;
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
          rememberTeam(dataA.tag, dataA.name);
          rememberTeam(dataB.tag, dataB.name);
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

    loadKnownTeams();
    setMode("team");

    return { open, close, toggle };
  }

  const PANEL_CSS = `
    :host, * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .fab {
      position: fixed; right: 20px; bottom: 20px;
      width: 48px; height: 48px; border-radius: 50%;
      background: #ff8a1e; color: #1a1100; border: none;
      font-size: 20px; cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,0.4);
      z-index: 2147482999;
    }
    .fab:hover { filter: brightness(1.08); transform: scale(1.05); }
    .backdrop {
      position: fixed; inset: 0; background: rgba(0,0,0,0.4);
      opacity: 0; pointer-events: none; transition: opacity 0.15s ease;
      z-index: 2147483000;
    }
    .backdrop.open { opacity: 1; pointer-events: auto; }
    .panel {
      position: fixed; top: 0; right: 0; height: 100vh; width: 400px;
      max-width: 92vw;
      background: #15171c; color: #e7e9ee;
      font-family: "Segoe UI", Roboto, system-ui, sans-serif; font-size: 13px;
      box-shadow: -8px 0 24px rgba(0,0,0,0.4);
      transform: translateX(100%); transition: transform 0.2s ease;
      z-index: 2147483001;
      display: flex; flex-direction: column;
      overflow-y: auto;
    }
    .panel.open { transform: translateX(0); }

    :root { }
    .head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 14px 10px; border-bottom: 1px solid #2a2e38; flex-shrink: 0;
    }
    .logo { font-weight: 700; font-size: 14px; }
    .head-right { display: flex; align-items: center; gap: 8px; }
    .mode-switch { display: flex; background: #1c1f27; border-radius: 7px; padding: 2px; border: 1px solid #2a2e38; }
    .mode-btn { border: none; background: transparent; color: #8a8f9c; padding: 5px 10px; font-size: 12px; font-weight: 600; border-radius: 5px; cursor: pointer; }
    .mode-btn.active { background: #4a3015; color: #ff8a1e; }
    .close-btn { background: none; border: none; color: #8a8f9c; font-size: 16px; cursor: pointer; padding: 2px 6px; }
    .close-btn:hover { color: #e7e9ee; }

    .inputs { display: grid; grid-template-columns: 1fr auto 1fr; align-items: end; gap: 8px; padding: 14px; }
    .field { display: flex; flex-direction: column; gap: 4px; position: relative; }
    .field-label { font-size: 11px; color: #8a8f9c; }
    .field input {
      background: #1c1f27; border: 1px solid #2a2e38; color: #e7e9ee;
      border-radius: 6px; padding: 7px 8px; font-size: 13px; width: 100%; font-family: inherit;
    }
    .field input:focus { outline: 2px solid #ff8a1e; outline-offset: -1px; }
    .vs { color: #8a8f9c; font-size: 11px; font-weight: 700; padding-bottom: 9px; justify-self: center; }
    .compare-btn {
      grid-column: 1 / -1; margin-top: 4px; background: #ff8a1e; color: #1a1100;
      border: none; border-radius: 7px; padding: 9px; font-size: 13px; font-weight: 700; cursor: pointer; font-family: inherit;
    }
    .compare-btn:hover { filter: brightness(1.08); }
    .compare-btn:disabled { opacity: 0.5; cursor: default; }

    .find-link { align-self: flex-start; background: none; border: none; color: #ff8a1e; font-size: 11px; font-weight: 600; padding: 2px 0 0; cursor: pointer; font-family: inherit; }
    .find-link:hover { text-decoration: underline; }

    .finder { margin: 0 14px 10px; padding: 10px; background: #1c1f27; border: 1px solid #2a2e38; border-radius: 7px; display: flex; flex-direction: column; gap: 8px; }
    .finder-row { display: flex; gap: 6px; }
    .finder-team-input { flex: 1; background: #15171c; border: 1px solid #2a2e38; color: #e7e9ee; border-radius: 6px; padding: 6px 8px; font-size: 12px; font-family: inherit; }
    .finder-load-btn { background: #4a3015; color: #ff8a1e; border: 1px solid #2a2e38; border-radius: 6px; padding: 6px 10px; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; font-family: inherit; }
    .finder-load-btn:hover { filter: brightness(1.15); }
    .finder-roster { background: #15171c; border: 1px solid #2a2e38; color: #e7e9ee; border-radius: 6px; padding: 6px 8px; font-size: 12px; font-family: inherit; }
    .finder-status { font-size: 11px; color: #8a8f9c; }
    .finder-status.error { color: #f87171; }

    .status { padding: 10px 14px; color: #8a8f9c; }
    .status.error { color: #f87171; }
    .result { padding: 0 14px 20px; }
    .names { display: grid; grid-template-columns: 1fr auto 1fr; gap: 8px; padding: 2px 0 10px; }
    .name-cell { font-weight: 700; font-size: 14px; overflow-wrap: anywhere; }
    .name-cell.a { text-align: left; }
    .name-cell.b { text-align: right; }
    .names .vs-mid { color: #8a8f9c; font-size: 11px; align-self: center; }
    .section-title { color: #8a8f9c; font-size: 11px; letter-spacing: 0.02em; margin: 12px 0 6px; border-top: 1px solid #2a2e38; padding-top: 10px; }
    .stat-row { display: grid; grid-template-columns: 1fr 86px 1fr; align-items: center; gap: 8px; padding: 4px 0; }
    .stat-val { font-weight: 700; font-variant-numeric: tabular-nums; }
    .stat-val.a { text-align: left; }
    .stat-val.b { text-align: right; }
    .stat-val.win { color: #4ade80; }
    .stat-label { text-align: center; color: #8a8f9c; font-size: 11px; }
    .trend-note { font-size: 12px; color: #8a8f9c; line-height: 1.5; padding: 2px 0; }
    .trend-note b { color: #e7e9ee; }
  `;

  const { root } = buildPanel();
  panelApi = wirePanel(root);
})();
