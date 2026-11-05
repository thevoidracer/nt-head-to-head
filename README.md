# NT Head-to-Head

Compare any two Nitro Type racers or teams, side by side, right from a tab
inside Nitro Type itself — as a Chrome extension.

Idea and spec by Void Racer. Built with Claude Code.

## What it does

Once installed, a **⚡ Head-to-Head** tab appears in Nitro Type's own nav
bar (next to Garage, Season, Shop, etc.) on every nitrotype.com page, and
a red ⚡ button is fixed to the bottom-right corner of every page as a
guaranteed-visible way in too. Click either one to open a full-page
comparison view, styled to match Nitro Type's own navy/red/gold look.

- **Teams**: roster size, active %, this-week pace against the race
  requirement, and all-time/daily speed, accuracy, and points — pulled
  from Nitro Type's own public team API. The team fields remember every
  team you've looked up, so typing part of a tag you've used before
  suggests it.
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
- The toolbar icon (no popup) also toggles the panel open/closed on the
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
6. Visit nitrotype.com — the ⚡ Head-to-Head tab appears in the nav bar.

To update later: re-download, unzip over the old folder, then click the
reload icon on the extension's card in `chrome://extensions`.

## Privacy

Everything runs locally in your own browser. The extension only talks to
`nitrotype.com` — nothing is sent anywhere else, and nothing is collected
or stored beyond what Chrome's own extension storage does automatically
(just the list of teams you've looked up, so autocomplete can suggest
them next time).
