# Tracker.gg Optimizer

A Tampermonkey userscript that cuts tracker.gg's memory and CPU use by stopping its
advertising stack from loading at all.

- **Script:** `tracker-gg-optimizer.user.js`
- **Version:** 1.2.0
- **Runs on:** `https://tracker.gg/*`, `https://*.tracker.gg/*`
- **Settings:** `Alt+O`

---

## Why the site is slow

The problem is not the stats pages. Profiling a stock `tracker.gg/valorant` load:

| Measurement | Stock page |
| --- | --- |
| JS heap | 55–82 MB |
| iframes | 25 (**19 third-party**) |
| `<script>` tags | 47 |
| `<video>` elements decoding HLS | 2 |
| Site's own DOM | ~1,400 nodes |

A 1,400-node DOM is small. The weight is the ad stack — NitroPay, Google
Publisher Tag, Prebid, Amazon `apstag`, Confiant, and a floating Primis video
player pinned at `z-index: 2147483646`.

The key detail: **each third-party iframe is a separate JavaScript realm.** It gets
its own heap, its own timers, its own `requestAnimationFrame` loops, and its own
garbage collector pressure — none of which the page can reclaim. Nineteen of them,
plus two video decoders running continuously, is the lag. It persists long after
the page finishes loading because those frames never stop working.

So the optimization is mostly one idea: **make the requests never fire.** Hiding ads
after they load leaves the cost in place; blocking them at `document-start` removes it.

---

## What the script does

Ordered by actual impact.

### 1. Blocks the ad stack before it loads

At `document-start`, the script patches the page's own APIs:

| Patch | Purpose |
| --- | --- |
| `Document.prototype.createElement` | Intercepts the `src` setter on `script`/`iframe`/`img` so a blocked URL is never assigned |
| `Node.prototype.appendChild` / `insertBefore` | Drops blocked nodes built via `setAttribute` or `innerHTML`, reporting success so the caller does not retry |
| `window.fetch` | Returns an empty `204` for blocked URLs |
| `XMLHttpRequest.open` / `send` | Redirects to a `data:` URL and suppresses the send |
| `navigator.sendBeacon` | Returns `true` without transmitting |

This is where nearly all the benefit comes from. Everything below is cleanup for
what a blocklist cannot catch.

### 2. Stubs the ad libraries

The site calls `nitroAds.createAd(...)`, `googletag.cmd.push(...)` and friends
directly. If those globals are missing the page throws, so the script installs
non-throwing placeholders for `nitroAds`, `googletag`, `pbjs`, `apstag`,
`confiant` and `Primis`, locked with a no-op setter so the real library cannot
replace them if it ever loads.

The `nitroAds` stub reports `abp: false` and `acceptable: true` — it says "no ad
blocker present" to anything that asks.

### 3. Reaps third-party iframes

Cookie-sync frames arrive seconds after load, so a 5-second sweep removes any
iframe whose hostname is not on the frame allow list. The sweep skips entirely
while the tab is hidden. This is the largest single memory win after blocking.

### 4. Kills the floating video player

Removes the Primis/sekindo container, and pauses, unsets and unloads any `<video>`
whose source is an ad host — stopping the decoder, not just hiding the picture.

### 5. Removes ad slots and their reserved space

Hides the ad containers, then walks up to three ancestors and collapses any wrapper
left empty, so you do not get bands of blank space where the ads used to be.

### 6. Rendering and lifecycle tweaks

- `content-visibility: auto` on cards, so off-screen ones are not rendered
- `loading="lazy"` / `decoding="async"` on off-screen images (above-the-fold images
  stay eager so first paint does not regress)
- `backdrop-filter: none` — GPU-expensive and purely cosmetic
- Pauses media and CSS animations while the tab is in the background
- `preconnect` to `api.tracker.gg` and `trackercdn.com`
- Re-runs cleanup on SPA route changes (`pushState`/`replaceState`/`popstate`)

---

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Open the Tampermonkey dashboard → **+** (Create a new script).
3. Replace the contents with `tracker-gg-optimizer.user.js` and save (`Ctrl+S`).

Dragging the `.user.js` file into a Chrome tab also works.

Tampermonkey is required rather than optional: the script uses `unsafeWindow` to
patch the real page context. Userscript managers sandbox scripts by default, and a
patch applied to the sandbox would never touch the page's own `fetch`.

---

## Settings

Press **Alt+O** on any tracker.gg page, or use the Tampermonkey menu. The panel also
shows live heap/frame/node counts and which hosts were blocked on this page.
Most toggles apply on reload.

| Setting | Default | Effect |
| --- | --- | --- |
| Block ads & bidders | on | NitroPay, GPT/Prebid, Amazon, cookie syncs |
| Block analytics | on | GA/GTM, Comscore, Cloudflare Insights |
| Kill floating video player | on | Primis/sekindo player and its decoder |
| Reap third-party iframes | on | Biggest memory win after blocking |
| Hide & collapse ad slots | on | Removes reserved empty space |
| Quiet background tab | on | Pauses media + animations when hidden |
| Skip off-screen rendering | on | `content-visibility` on cards |
| Lazy-load images | on | Off-screen images load on demand |
| Disable blur effects | on | `backdrop-filter` is GPU-expensive |
| Preconnect to API/CDN | on | Shaves the first-request handshake |
| Reduce motion | off | Near-instant animations |
| Unstick top nav | off | Nav scrolls away with the page |
| Show perf HUD | off | Live heap / frame / node counter |

Settings persist via `GM_setValue`, falling back to `localStorage`.

---

## Verification

Measured against the live site rather than assumed.

**Blocklist replayed over all 241 real requests from a full page load:**

- 135 blocked (56%) — ads, bidders, cookie syncs, analytics
- **0 ad requests passing through**
- **0 false positives.** Survivors are exactly the site's real infrastructure:
  `tracker.gg`, `api.tracker.gg`, `trackercdn.com`, `imgsvc.trackercdn.com`,
  `notifications.thetrackernetwork.com`, Google Fonts, Stripe, Firebase, reCAPTCHA

**DOM phase executed against the live page:**

| | Before | After |
| --- | --- | --- |
| iframes | 17 | 7 |
| `<video>` | 2 | 0 |
| DOM nodes | 1,327 | 1,017 |

Page content verified intact afterwards: `<h1>`, navigation, cards and 5,033
characters of body text all present.

**Two bugs found during that audit and fixed in 1.2.0:**

1. Matching on the full URL was unsafe in both directions — ad requests routinely
   carry `?url=https%3A%2F%2Ftracker.gg%2F` in their query strings, so a substring
   test could wave an ad through on the strength of its parameters. Matching is now
   hostname-suffix based (`sync.adnxs.com` matches `adnxs.com`; `notadnxs.com` does not).
2. Fourteen ad hosts were escaping the list entirely — `adsrvr.org`, `ad.gt`,
   `33across.com`, `1rx.io`, `contextweb.com`, `deepintent.com` and others. Added.

### Not verified

- **Heap reduction was not measured end-to-end.** That requires the script running at
  `document-start` under Tampermonkey. Removing frames after they load does not reclaim
  memory the way never loading them does, so the real figure should be better than
  anything measurable after the fact — but it is an expectation, not a measurement.
  Enable the perf HUD to see your own numbers.
- **No screenshot comparison.** Verification was structural (DOM intact, content
  present), not visual.

---

## Customizing

The host lists are plain arrays near the top of the script:

- `ALLOW_HOSTS` — never blocked, whatever else matches
- `AD_HOSTS` — ad networks, bidders, cookie syncs
- `AD_HOST_RE` — host families that vary by subdomain or ccTLD
- `ANALYTICS_HOSTS` — telemetry
- `FRAME_ALLOW` — iframes that survive the reaper

Entries are bare domains and match subdomains automatically, so `pubmatic.com`
covers `ads.pubmatic.com` and `hbopenbid.pubmatic.com`.

To find something new that is slipping through, open the Tampermonkey menu →
**Log blocked requests**, then compare against the network panel.

---

## Troubleshooting

**A page section is blank or missing.** Most likely a legitimate host got caught.
Open DevTools → Network, look for a blocked request to a `tracker.gg` or
`trackercdn.com` domain, and add its hostname to `ALLOW_HOSTS`.

**The site complains about an ad blocker.** The `nitroAds` stub is designed to
prevent this, but if detection changes, check that "Block ads & bidders" is on —
the stub only installs when it is. Note that the CSS deliberately avoids broad
`[class*="ad"]` rules, because the site plants a bait element whose class list is
`ad_row adbannertop ad-mobile ad_sidebar adpopup boxad contentAd`; hiding that is
exactly what detection measures.

**Payments or login break.** Stripe, reCAPTCHA and Firebase are explicitly allowed.
If something else is needed, add it to `ALLOW_HOSTS` and `FRAME_ALLOW`.

**Scroll position jumps.** Turn off "Skip off-screen rendering".

**Nothing happens at all.** Confirm the script is enabled in Tampermonkey and that
`@run-at document-start` survived the paste — the timing is what makes the blocking
work.

---

## Notes

The script blocks the site's advertising, which is how tracker.gg is funded. If you
use it regularly, their premium subscription removes the ads at the source — this is
a performance tool, not an argument that the ads should not exist.

Ad stacks change. If tracker.gg switches providers, the blocklist will need new
entries; the structure above is designed to make that a one-line edit.
