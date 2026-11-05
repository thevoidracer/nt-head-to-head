# NT Head-to-Head

Compare any two Nitro Type racers or teams, side by side, with recent-form
context — as a Chrome extension.

Idea and spec by Void Racer. Built with Claude Code.

## What it does

- **Teams**: roster size, active %, this-week pace against the race
  requirement, and all-time/season/daily speed, accuracy, and points —
  pulled from Nitro Type's own public team API.
- **Racers**: level, lifetime races, avg/top speed, season and today's
  performance, plus a quick "today's pace vs season average" line — pulled
  from the racer's own profile page (Nitro Type has no public JSON API for
  individual racers, so this parses the same embedded stats object the
  page itself renders from).
- Open the popup while on a team or racer page and side A auto-fills with
  whoever you're looking at.

## Install (not on the Chrome Web Store — load it manually)

1. Download this repo as a zip (Code → Download ZIP) or grab the zip from
   the [latest release](../../releases/latest).
2. Unzip it.
3. In Chrome, go to `chrome://extensions`.
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** and select the unzipped folder.

## Privacy

Everything runs locally in your own browser. The extension only talks to
`nitrotype.com` — nothing is sent anywhere else, and nothing is collected
or stored beyond what Chrome's own extension storage does automatically.
