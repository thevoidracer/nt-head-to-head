# TypeTrack

Compare any two Nitro Type racers or teams side by side, and browse every
team you've tracked — right from a tab inside Nitro Type itself, as a
Chrome extension.

Idea and spec by Void Racer. Built with Claude Code.

## What it does

Once installed, a **⚡ TypeTrack** tab appears in Nitro Type's own nav
bar (next to Garage, Season, Shop, etc.) on every nitrotype.com page, and
a red ⚡ button is fixed to the bottom-right corner of every page as a
guaranteed-visible way in too. Click either one to open a full-page view,
styled to match Nitro Type's own navy/red/gold look, with two tabs:

### Compare

- **Teams**: roster size, active %, this-week pace against the race
  requirement, and all-time/daily speed, accuracy, points, and
  points-per-race — pulled from Nitro Type's own public team API. Every
  row has a lead bar showing who's ahead at a glance, and a "stats won"
  duel score tallies the whole comparison, both styled after the
  community site [StarTrack](https://www.ntstartrack.org/)'s own
  Showdown comparator. The team fields remember every team you've looked
  up, so typing part of a tag you've used before suggests it.
- **Racers**: level, lifetime races, avg/top speed, league tier,
  membership, longest session, and account age — pulled from the racer's
  own profile page (Nitro Type has no public JSON API for individual
  racers, so this parses the same embedded data object the page itself
  renders from). Nitro Type no longer exposes a season/daily breakdown on
  that page, so this is lifetime data, not a recent-form snapshot.
- Don't know someone's exact username? Click **Find by name** under
  either racer field, load a team's roster by tag, and pick them by their
  display name — their real username fills in automatically.
- Open the panel while on a team or racer page and side A auto-fills with
  whoever you're looking at.

### Teams

A full, searchable grid of every team this install knows about — the
same card-based "Browse teams" layout as TypeTrack's own site-wide team
filterer, instead of having to shuffle through Nitro Type's own team
browser one page at a time. Each card shows the team's tag and name
(colored to match its real in-game tag color), captain, member count,
formed date, and race/speed requirement, plus a **View roster** link
out to its real nitrotype.com team page and when you last looked it
up. Type part of a tag or name to filter; click a card to send that
team straight into Compare as Team A.

Nitro Type doesn't publish a full list of every team (its own in-game
search needs a login token this extension deliberately doesn't touch),
so the grid starts from a curated set of active/notable teams and
grows permanently from there, with fresh details each time: every team
you compare, look up, or simply visit the page of on nitrotype.com
gets added to (or refreshed in) your own local list automatically.

The toolbar icon (no popup) also toggles the panel open/closed on the
active nitrotype.com tab, as a backup if the nav tab is ever hard to
find.

## Install (not on the Chrome Web Store — load it manually)

1. Download this repo as a zip: [direct download
   link](../../archive/refs/heads/main.zip), or Code → Download ZIP from
   the repo page.
2. Unzip it.
3. In Chrome, go to `chrome://extensions`.
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** and select the unzipped folder.
6. Visit nitrotype.com — the ⚡ TypeTrack tab appears in the nav bar.

To update later: re-download, unzip over the old folder, then click the
reload icon on the extension's card in `chrome://extensions`.

## Privacy

Everything runs locally in your own browser. The extension only talks to
`nitrotype.com` — nothing is sent anywhere else, and nothing is collected
or stored beyond what Chrome's own extension storage does automatically
(just the list of teams you've looked up, so the Teams tab and
autocomplete can suggest them next time).
