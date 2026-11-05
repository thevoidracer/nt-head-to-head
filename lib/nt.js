// NT Head-to-Head — data layer.
//
// Teams have a clean public JSON endpoint. Racers do not: Nitro Type never
// published a JSON API for an individual racer, so the only way to get one
// is to fetch the HTML of their profile page and pull the embedded
// `RACER_INFO: {...}` object out of an inline <script> block with a regex,
// the same trick every third-party NT tool (e.g. the NT.py library) relies
// on. Because this extension declares host_permissions for nitrotype.com,
// both fetches are plain cross-origin fetch() calls from the popup — no
// content script or injection needed, and it works even if the user has
// never opened that page.

const NT = (() => {
  "use strict";

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // NT's API will occasionally answer a burst of requests with HTTP 429
  // (seen under this extension's own background seeding/sync load, not
  // just heavy external traffic) — a couple of short, spaced-out retries
  // clears it almost every time, rather than surfacing a failure to the
  // user for something that will plainly succeed a second later.
  async function fetchWithRetry(url, { retries = 3, baseDelayMs = 1500 } = {}) {
    let lastRes;
    for (let attempt = 0; attempt <= retries; attempt++) {
      lastRes = await fetch(url);
      if (lastRes.status !== 429) return lastRes;
      if (attempt < retries) await sleep(baseDelayMs * (attempt + 1));
    }
    return lastRes;
  }

  function deriveStats(board) {
    // board: {played, typed, secs, errs} — the shape NT uses everywhere
    // (team boards and a racer's racingStats entries alike).
    if (!board || !board.secs) {
      return { races: board?.played || 0, speed: 0, accuracy: 0, points: 0, ppr: 0 };
    }
    const { played = 0, typed = 0, secs = 0, errs = 0 } = board;
    const speed = secs ? (typed / 5 / secs) * 60 : 0;
    const accuracy = typed ? 100 - (errs / typed) * 100 : 100;
    const points = played * (100 + speed / 2) * (accuracy / 100);
    // Points-per-race — the efficiency metric StarTrack (the community
    // leaderboard site) surfaces as "PPR" next to its own points column.
    const ppr = played ? Math.round(points / played) : 0;
    return {
      races: played,
      speed: Math.round(speed * 10) / 10,
      accuracy: Math.round(accuracy * 10) / 10,
      points: Math.round(points),
      ppr,
    };
  }

  async function fetchTeam(tag) {
    const clean = tag.trim().toUpperCase();
    const res = await fetchWithRetry(`https://www.nitrotype.com/api/v2/teams/${encodeURIComponent(clean)}`);
    if (!res.ok) throw new Error(`Team lookup failed (HTTP ${res.status})`);
    const json = await res.json();
    if (!json || json.status !== "OK" || !json.results) {
      throw new Error(`No team found for tag "${clean}"`);
    }
    const { info = {}, members = [] } = json.results;

    const boards = {};
    for (const b of info.stats || json.results.stats || []) {
      boards[b.board] = deriveStats(b);
    }
    // Some responses carry stats at results.stats rather than info.stats —
    // handled above by falling back to json.results.stats.

    const now = Date.now();
    const weekStart = (() => {
      const d = new Date();
      const day = (d.getUTCDay() + 6) % 7; // Mon=0
      d.setUTCDate(d.getUTCDate() - day);
      d.setUTCHours(0, 0, 0, 0);
      return d.getTime();
    })();

    const minRaces = info.minRaces || 0;
    let onPace = 0;
    let eligible = 0;
    for (const m of members) {
      if (!minRaces) continue;
      eligible++;
      if ((m.played || 0) >= minRaces) onPace++;
    }

    const activeRecently = members.filter((m) => {
      if (!m.lastActivity) return false;
      const days = (now - m.lastActivity * 1000) / 86400000;
      return days <= 3;
    }).length;

    return {
      kind: "team",
      tag: clean,
      name: info.name || clean,
      memberCount: members.length,
      members,
      info,
      boards,
      trend: {
        minRaces,
        onPaceCount: onPace,
        eligibleCount: eligible,
        activeRecentlyCount: activeRecently,
        activePercent: info.activePercent ?? null,
        weekStart,
      },
    };
  }

  async function fetchRacer(username) {
    const clean = username.trim();
    const res = await fetchWithRetry(`https://www.nitrotype.com/racer/${encodeURIComponent(clean)}`);
    if (!res.ok) throw new Error(`Racer lookup failed (HTTP ${res.status})`);
    const html = await res.text();

    const match = html.match(/RACER_INFO:\s*(\{.*?\})\s*,?\s*\n/) || html.match(/RACER_INFO:\s*(\{[\s\S]*?\})\s*;/);
    if (!match) throw new Error(`Couldn't find racer "${clean}" (profile may be private or the tag changed)`);

    let data;
    try {
      data = JSON.parse(match[1]);
    } catch (e) {
      throw new Error(`Couldn't read racer "${clean}"'s profile data`);
    }

    // Nitro Type's racer profile page used to embed a per-period
    // `racingStats` breakdown (season/daily), which is what older
    // third-party tools document — but it's gone from the live page as of
    // this build. Only lifetime-level fields are actually embedded now, so
    // that's what this returns; there's no real "today vs season" split
    // available from this endpoint anymore.
    const accountAgeDays = data.createdStamp ? Math.floor((Date.now() / 1000 - data.createdStamp) / 86400) : null;

    return {
      kind: "racer",
      username: data.username || clean,
      displayName: data.displayName || data.username || clean,
      tag: data.tag || null,
      level: data.level || null,
      experience: data.experience || null,
      racesPlayed: data.racesPlayed || 0,
      avgSpeed: data.avgSpeed || 0,
      highestSpeed: data.highestSpeed || 0,
      longestSession: data.longestSession || 0,
      leagueTier: data.leagueTier ?? null,
      membership: data.membership || "basic",
      nitrosUsed: data.nitrosUsed || 0,
      accountAgeDays,
    };
  }

  return { deriveStats, fetchTeam, fetchRacer };
})();
