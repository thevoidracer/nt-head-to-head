(() => {
  "use strict";

  const state = { mode: "team" };

  const els = {
    modeBtns: document.querySelectorAll(".mode-btn"),
    labelA: document.getElementById("label-a"),
    labelB: document.getElementById("label-b"),
    inputA: document.getElementById("input-a"),
    inputB: document.getElementById("input-b"),
    form: document.getElementById("compare-form"),
    btn: document.querySelector(".compare-btn"),
    status: document.getElementById("status"),
    result: document.getElementById("result"),
  };

  function setMode(mode) {
    state.mode = mode;
    els.modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    const isTeam = mode === "team";
    els.labelA.textContent = isTeam ? "Team A tag" : "Racer A username";
    els.labelB.textContent = isTeam ? "Team B tag" : "Racer B username";
    els.inputA.placeholder = isTeam ? "e.g. IMT" : "e.g. voidracer";
    els.inputB.placeholder = isTeam ? "e.g. KU" : "e.g. speedking";
  }

  els.modeBtns.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

  // Auto-detect: if the active tab is already on a racer or team page,
  // pre-fill side A and switch to the matching mode, so a captain can
  // open this from their own team's page and just type an opponent.
  function detectContext() {
    if (!chrome.tabs) return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs && tabs[0] && tabs[0].url;
      if (!url) return;
      const teamMatch = url.match(/nitrotype\.com\/team\/([^/?#]+)/i);
      const racerMatch = url.match(/nitrotype\.com\/racer\/([^/?#]+)/i);
      if (teamMatch) {
        setMode("team");
        els.inputA.value = decodeURIComponent(teamMatch[1]);
        els.inputB.focus();
      } else if (racerMatch) {
        setMode("racer");
        els.inputA.value = decodeURIComponent(racerMatch[1]);
        els.inputB.focus();
      }
    });
  }

  function fmtPct(n) {
    return n === null || n === undefined ? "—" : `${n}%`;
  }

  function statRow(label, aVal, bVal, { higherIsBetter = true, suffix = "" } = {}) {
    const an = typeof aVal === "number" ? aVal : parseFloat(aVal);
    const bn = typeof bVal === "number" ? bVal : parseFloat(bVal);
    let aWin = false, bWin = false;
    if (!Number.isNaN(an) && !Number.isNaN(bn) && an !== bn) {
      if (higherIsBetter ? an > bn : an < bn) aWin = true;
      else bWin = true;
    }
    const aText = `${aVal ?? "—"}${suffix}`;
    const bText = `${bVal ?? "—"}${suffix}`;
    return `
      <div class="stat-row">
        <span class="stat-val a ${aWin ? "win" : ""}">${aText}</span>
        <span class="stat-label">${label}</span>
        <span class="stat-val b ${bWin ? "win" : ""}">${bText}</span>
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
        <span class="name-cell a">[${a.tag}] ${a.name}</span>
        <span class="vs-mid">vs</span>
        <span class="name-cell b">${b.name} [${b.tag}]</span>
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
    const boardRows = (boardName, title) => {
      const ba = a.boards[boardName];
      const bb = b.boards[boardName];
      return `
        <div class="section-title">${title}</div>
        ${statRow("Races", ba.races, bb.races)}
        ${statRow("Speed", ba.speed, bb.speed, { suffix: " wpm" })}
        ${statRow("Accuracy", ba.accuracy, bb.accuracy, { suffix: "%" })}
        ${statRow("Points", ba.points, bb.points)}`;
    };

    const trendLine = (r) => {
      const seasonSpeed = r.boards.season.speed;
      const dailySpeed = r.boards.daily.speed;
      if (!seasonSpeed || !dailySpeed) return `No races logged yet today.`;
      const delta = Math.round((dailySpeed - seasonSpeed) * 10) / 10;
      const dir = delta > 0.5 ? "up" : delta < -0.5 ? "down" : "steady";
      return `Today's pace is <b>${dir}</b> ${delta > 0 ? "+" : ""}${delta} wpm vs this season's average.`;
    };

    return `
      <div class="names">
        <span class="name-cell a">${a.displayName}${a.tag ? ` [${a.tag}]` : ""}</span>
        <span class="vs-mid">vs</span>
        <span class="name-cell b">${b.displayName}${b.tag ? ` [${b.tag}]` : ""}</span>
      </div>
      <div class="section-title">Profile</div>
      ${statRow("Level", a.level, b.level)}
      ${statRow("Lifetime races", a.racesPlayed, b.racesPlayed)}
      ${statRow("Avg speed", a.avgSpeed, b.avgSpeed, { suffix: " wpm" })}
      ${statRow("Top speed", a.highestSpeed, b.highestSpeed, { suffix: " wpm" })}
      ${boardRows("season", "This season")}
      ${boardRows("daily", "Today")}
      <div class="section-title">Recent form</div>
      <div class="trend-note">${a.displayName}: ${trendLine(a)}</div>
      <div class="trend-note">${b.displayName}: ${trendLine(b)}</div>`;
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
    } catch (err) {
      setStatus(err.message || "Something went wrong.", true);
    } finally {
      els.btn.disabled = false;
    }
  });

  detectContext();
})();
