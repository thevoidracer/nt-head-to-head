# TypeTrack

Compare any two Nitro Type racers or teams side by side, and browse every
team you've tracked — right from a tab inside Nitro Type itself, as a
Chrome extension.

Idea and spec by Void Racer. Built with Claude Code.

## What it does

Once installed, a **⚡ TypeTrack** tab appears in Nitro Type's own nav
bar (next to Garage, Season, Shop, etc.) on every nitrotype.com page —
or press **Alt+T** anywhere on the site. Either one opens a centered,
rounded card styled to match Nitro Type's own look and feel, with four
tabs — **1**/**2**/**3**/**4** switch between them while the panel is
open, and **/** jumps to the Teams search box:

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
— click a card to open that team's roster right inside the panel
(see "In-panel team detail" below); the real nitrotype.com team page
is still one click away from there.

**Find teams for me**: click this button above the search box to rank
every tracked team against your own avg speed (pulled from your "my
racer" setting) — it fills in the speed filter and sorts toughest-
qualifying-first, so you can see which teams you'd already clear the
speed bar for, from the most competitive down to the most comfortable.

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

### In-panel team detail

Clicking a team card opens its full roster right inside the TypeTrack
panel — tag, name, member count, requirements, and every member's race
count — without leaving the page or opening a new tab. Watch/unwatch
the team from here too. If it's your own team, the roster table gains
two extra columns: **Trend** (races played today vs. yesterday,
recorded automatically in the background) and **Proj. this week**
(your current pace projected to the end of the week), plus a note on
whoever's been quietest lately — a captain's view of the roster, not
just a snapshot.

### Compare history

Every Compare you run is saved locally (last 20). Click **Recent
comparisons** under the Compare form to browse them — picking one
re-fills the form and shows that saved result again, labeled with how
long ago it was run, so you can see how a matchup has shifted since
without re-fetching anything.

The panel is styled to match Nitro Type itself, not just sit on top of
it: it's set in Montserrat (the same font Nitro Type's own page already
loads, referenced directly rather than shipped separately), uses Nitro
Type's own red, and opens as a centered, deeply-rounded, gold-ringed
card with chunky beveled buttons — the same "game button" look as the
site's own UI — instead of a flat rectangle covering the whole page.
[Manrope](https://github.com/google/fonts/tree/main/ofl/manrope) is
still self-hosted as a fallback in case Montserrat isn't available for
some reason.

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

### Notification dot

The nav tab shows a small red dot — no number — whenever there's
something to notice: a team has shown up (from your own browsing or
the shared list) since you last opened the Teams tab, or the extension
has updated since you last opened the panel. It clears the moment you
act on it — opening the Teams tab clears the team half, opening the
panel at all clears the update half.

### Watch a team for changes

Click the ☆ star on any card in the Teams tab to watch it (up to 10 at
once — it turns into ★). Roughly every 30 minutes, even with no
nitrotype.com tab open, the extension quietly re-checks every watched
team and fires a desktop notification if its captain changes, its
race/speed requirement changes, or its member count swings by 5 or
more. Your own team (see auto-detection above) gets starred for you
automatically the first time it's detected — unstar it any time and it
stays unstarred.

### More on-page widgets — on Nitro Type itself, not just the panel

These show up directly on Nitro Type's own pages, the same way the
comparison badges above do, once your team/racer is set:

- **Your progress, on your own racer page**: a floating badge replaces
  the usual "vs you" comparison badge when you're looking at your own
  profile, showing how your races-played and avg speed have moved over
  the last 7 days, trending up/down/steady, plus a small line chart of
  your recent avg-speed snapshots. A background snapshot of your stats
  is taken roughly once a day (even with no tab open) so this has real
  history to show, not just today's number.
- **Daily race goal + streak**: set an optional daily race goal from
  the ⚙ settings popover. Hit it on a given day and your streak ticks
  up; miss it and it resets. The streak shows inside your progress
  badge and on the panel's Today tab.
- **Roster compliance, on your own team page**: a floating badge
  replaces the usual comparison badge when you're looking at your own
  team's page, listing exactly which members are currently below the
  team's race requirement (and by how much), instead of having to
  cross-check the roster by hand.
- **Rival tracking**: on any other racer's page, click **☆ Add rival**
  on their comparison badge to track them (up to 5 at once — it turns
  into **★ Rival**). Roughly every 30 minutes, the extension compares
  your avg speed to theirs and fires a desktop notification the moment
  the lead flips either way.

### Racers tab — a multi-racer dashboard

A third panel tab beyond Compare and Teams: add any racer's username
(or use the ☆ Add rival button on a comparison badge — it's the same
list, up to 8) to see all of them side by side — avg speed, top speed,
lifetime races — refreshed on demand with a **Refresh** button, rather
than checking one at a time.

### Race Now, right from the panel

A gold **🏁 Race Now** button sits in the panel header, next to the
Compare/Teams/Racers switch, and jumps straight to an actual race.

### Export your results

Every Compare result gets an **Export as CSV** link underneath it, for
sharing a matchup outside the extension. Your own progress badge (on
your racer page) has a matching **⤓ CSV** button that exports your
whole recorded snapshot history — date, lifetime races, avg speed, top
speed, one row per day.

### Milestones

Your progress badge also shows simple milestone badges — 🏁 lifetime
race-count tiers, ⚡ avg-speed-peak tiers, and 🔥 your best-ever daily
goal streak — computed straight from the history already being
recorded, no extra tracking needed.

### Team activity heatmap

On your own team's detail view (click your team's card in the Teams
tab), a 24-hour strip shows which hours of the day — in your own local
time — your team races most, built from the same background snapshots
that power the captain-trend columns. Needs a day or two of tracking
before it has enough samples to show anything.

### Themes

Pick an alternate accent-color palette from the ⚙ settings popover —
Nitro Red (default), Gold Rush, Blue Steel, or Nitro Green. Applies
everywhere: the panel and every on-page badge.

### Quicker to use

A few things that cut down on typing and clicking:

- **Smarter auto-fill**: side A on Compare fills in from the page you're
  on, same as before — but if you're not on a team/racer page, it now
  falls back to your own team/racer (from ⚙ Settings) by default.
- **My Team button**: once your team is set, a button next to Race Now
  jumps straight to your own team's roster from anywhere in the panel.
- **Track from a roster**: every row in a team's detail view now has a
  ☆ button to add that racer straight to the Racers dashboard, no
  copy-pasting their username.
- **Icon-labeled tabs**: Compare/Teams/Racers/Today each get a small
  icon next to the label, for a quicker glance at the tab bar.

### Today — a daily check-in

A fourth panel tab (or press **4**): today's race count against your
daily goal, your current and best streak, and — if "my team" is set —
roughly when that team tends to race most, all pulled from data already
being tracked in the background. A **📷 Share stat card** button here
exports a styled PNG of your lifetime races, avg speed, streak, and team
— ready to drop into a team Discord or chat.

### Share TypeTrack with your team

A **📋 Share TypeTrack** button in the ⚙ settings popover copies a short
install blurb and download link to your clipboard, so inviting teammates
doesn't mean hunting down this repo's link yourself.

### Team banter

Your own team's detail view adds a few lighthearted superlatives above
the roster table — top racer this week and who's on fire today —
computed from the same trend data the Trend/Proj.
columns already use, just surfaced as a quick callout instead of having
to scan the table for them.

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
