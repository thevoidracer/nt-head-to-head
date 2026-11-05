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

A full, searchable, filterable grid of every team this install knows
about — the same card-based "Browse teams" layout as TypeTrack's own
site-wide team filterer, instead of having to shuffle through Nitro
Type's own team browser one page at a time. Each card shows the
team's tag and name (colored to match its real in-game tag color),
captain, member count, formed date, race/speed requirement, and when
you last looked it up. Type part of a tag or name to search, sort by
member count, how recently a team formed, or its speed requirement,
and cap results by max min-speed, max min-races, or min member count
— click a card to open that team's real nitrotype.com team page in a
new tab.

Nitro Type doesn't publish a full list of every team (its own in-game
search needs a login token this extension deliberately doesn't touch),
so the grid starts from a curated set of active/notable teams and
grows permanently from there, with fresh details each time: every team
you compare, look up, or simply visit the page of on nitrotype.com
gets added to (or refreshed in) your own local list automatically —
**and gets shared with every other TypeTrack install**, through a
small, open team database the extension syncs to in the background.
Find a team once, anywhere, and it shows up in everyone else's Teams
tab too.

The toolbar icon (no popup) also toggles the panel open/closed on the
active nitrotype.com tab, as a backup if the nav tab is ever hard to
find.

The whole panel is set in [Manrope](https://github.com/google/fonts/tree/main/ofl/manrope),
the same clean, squared-but-flowing geometric sans [StarTrack](https://www.ntstartrack.org/)
itself uses — self-hosted in the extension so it always loads regardless
of nitrotype.com's own content-security policy.

### On-page comparisons, without opening the panel at all

Open the **⚙** gear in the panel header once — if you're logged into
Nitro Type, "my team" and "my racer" auto-fill themselves straight off
NT's own page (your account dropdown's profile link, your nav's team
link), no typing needed. Change either one any time; your own edit
always sticks. From then on:

- Visit any *other* team's real nitrotype.com page and a small badge
  floats in showing how it stacks up against yours — member count, min
  races, min speed, and a one-line "lower/higher requirements than
  yours" verdict.
- Visit any *other* racer's profile page and the same kind of badge
  compares their avg speed, top speed, and lifetime races to your own
  racer.
- Click either badge to jump straight into a full, already-run Compare
  with both sides filled in.

### Unseen-teams counter

The fab and the nav tab both show a small gold counter for how many
teams have shown up — from your own browsing or from the shared list —
since you last actually opened the Teams tab. It clears the moment you
open it.

### Watch a team for changes

Click the ☆ star on any card in the Teams tab to watch it (up to 10 at
once — it turns into ★). Roughly every 30 minutes, even with no
nitrotype.com tab open, the extension quietly re-checks every watched
team and fires a desktop notification if its captain changes, its
race/speed requirement changes, or its member count swings by 5 or
more.

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

Racer and team lookups only ever talk to `nitrotype.com` itself. The one
exception is the shared team list: basic public team info (tag, name,
color, captain, member count, requirements) is synced to and from a
small open database so every install's Teams tab benefits from what every
other install has found — nothing tied to your own account or identity is
ever sent. The "my team" / "my racer" settings (whether auto-detected or
typed in) and your watch list never leave your own browser — they're
only ever used to build ordinary NT API calls from your machine, and
auto-detection only ever reads two ordinary links already on NT's own
page, never your cookies, login token, or any other account data.
Nothing else is collected or stored beyond what
Chrome's own extension storage does automatically (the list of teams
you've looked up, so the Teams tab and autocomplete can suggest them
next time).
