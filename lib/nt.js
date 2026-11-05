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

  function deriveStats(board) {
    // board: {played, typed, secs, errs} — the shape NT uses everywhere
    // (team boards and a racer's racingStats entries alike).
    if (!board || !board.secs) {
      return { races: board?.played || 0, speed: 0, accuracy: 0, points: 0 };
    }
    const { played = 0, typed = 0, secs = 0, errs = 0 } = board;
    const speed = secs ? (typed / 5 / secs) * 60 : 0;
    const accuracy = typed ? 100 - (errs / typed) * 100 : 100;
    const points = played * (100 + speed / 2) * (accuracy / 100);
    return {
      races: played,
      speed: Math.round(speed * 10) / 10,
      accuracy: Math.round(accuracy * 10) / 10,
      points: Math.round(points),
    };
  }

  async function fetchTeam(tag) {
    const clean = tag.trim().toUpperCase();
    const res = await fetch(`https://www.nitrotype.com/api/v2/teams/${encodeURIComponent(clean)}`);
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
    const res = await fetch(`https://www.nitrotype.com/racer/${encodeURIComponent(clean)}`);
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

    // racingStats: index 0 = season board, index 1 = daily board (per the
    // field order Nitro Type's own page embeds them in).
    const season = deriveStats(data.racingStats?.[0]);
    const daily = deriveStats(data.racingStats?.[1]);

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
      membership: data.membership || "basic",
      boards: { season, daily },
      trend: {
        daily,
        season,
      },
    };
  }

  return { deriveStats, fetchTeam, fetchRacer };
})();
