# Yangon Storm Watch · ရန်ကုန် မုန်တိုင်း

A calm, bilingual (English / Burmese) storm tracker for **Yangon, Myanmar**: made for a family member abroad
and for parents at home in Yangon. It answers one question first: *does anything threaten Yangon right now,
and what should we do?*

Live site: <https://eduwhale.info>

> **Unofficial.** This page gathers public data and is not affiliated with the Department of Meteorology and
> Hydrology (DMH, မိုးဇလ). Always follow DMH warnings and local authorities.

## What it shows

- **Attention level for Yangon**: *Calm, Monitor, Prepare, Danger* (or *Unknown — check DMH* when data is
  missing; it never says "Calm" by default). A plain headline, the reasons, and what to do.
- **Official DMH bulletin**: the newest DMH cyclone warning or news, with DMH's own colour stage (Yellow →
  Orange → Red → Brown → Green), issue time, position and distance from Yangon, and the bulletin text in
  English or Burmese.
- **Tropical storms**: JTWC warnings, formation alerts and invest areas, plus GDACS tracks. For each: distance
  and direction from Yangon, wind, movement, and the closest forecast approach.
- **Map**: Himawari infrared satellite (loop on request), rain radar, storm tracks, forecast cones, wind areas,
  formation-alert corridors, the DMH position, and 150/300/600 km rings around Yangon. There is also a Windy
  live-wind tab.
- **Now in Yangon**, **next 48 hours** (wind and rain charts) and a **10-day outlook** from Open-Meteo.
- **Be prepared**: a checklist that saves progress on the device, storm-surge advice for riverside townships,
  and **emergency numbers**: 191 fire and rescue, 192 ambulance, 199 police, and the DMH weather lines.
- **Settings**: works offline with the last data, light/dark theme, and km/h or mph.

## Where the data comes from

| Source | Read by | Used for |
|---|---|---|
| [DMH Myanmar](https://www.moezala.gov.mm/en/cyclone-news) | GitHub Actions, every 30 min → `data/dmh.json` | The official stage, bulletin text and position |
| [JTWC](https://www.metoc.navy.mil/jtwc/jtwc.html) (US Navy) | the browser | Warnings with forecast tracks, formation alerts, invests |
| [GDACS](https://www.gdacs.org/) (EU / UN) | the browser | Tracks, forecast cones and wind areas |
| [Open-Meteo](https://open-meteo.com/) | the browser | Yangon forecast (CC BY 4.0) |
| [NASA GIBS](https://earthdata.nasa.gov/gibs) / JMA Himawari, [RainViewer](https://www.rainviewer.com/) | the browser | Satellite and radar imagery |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) | the browser | Base map (with Burmese place names) |

No single feed is enough. On 28 Sep 2026, while this site was being built, a Deep Depression crossed the
coast about 90 km from Yangon:
- DMH put it at **Brown stage**.
- JTWC had only a formation alert.
- GDACS did not list it at all.

The site therefore takes the **highest** level from all sources, and treats missing data as *Unknown*.

## How the attention level is decided

Every threshold lives in [`js/config.js`](js/config.js) (`THRESHOLDS`), and the "How this works" section on
the page is generated from it. The final level is the highest of these four:

1. **DMH:** a current bulletin's stage, which applies fully when the storm is within 500 km of Yangon or the
   bulletin names Yangon.
2. **Storms:** how close each system's current position or forecast track comes to Yangon, how strong it is,
   and when. This includes whether Yangon lies inside a forecast wind area or cone.
3. **Local forecast (next 72 h):** gusts, steady wind, and rain over 1, 24, 48 and 72 hours.
4. **Manual override:** optional, see below.

If both storm feeds fail and DMH can't be checked, the level is *Unknown*. It is never *Calm*.

## Setup (repository owner)

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
   - The `Deploy site` workflow ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)) then publishes
     the site on every push to `main` and every 30 minutes, with fresh DMH data.
   - The custom domain (`eduwhale.info`) stays set in Pages settings.
   - Until you switch the source, the workflow skips itself with a notice (no failure emails). The site still
     works from the branch, but shows "automatic DMH check not set up".
2. The schedule keeps itself alive: it re-enables itself weekly, because GitHub pauses scheduled workflows after
   60 days without activity. If DMH checks ever stop, open **Actions → Deploy site → Enable workflow**.
3. **Manual override (optional):** edit [`data/override.json`](data/override.json) on GitHub.
   - Set `"enabled": true`, a `minLevel` (1–3), an `expires` time, and a message in both languages.
   - The site raises its level to at least that until it expires. Use it if DMH warns about something the
     automatic feeds miss.

## Development

No build step and no dependencies. You need Node.js 20+ for the tests and the DMH fetcher.

```sh
npm test                      # unit tests (node --test), using real captured fixtures
npm run serve                 # http://localhost:8080
node scripts/fetch-dmh.mjs --out data/dmh.json                             # live DMH check (data/dmh.json is git-ignored)
node scripts/fetch-dmh.mjs --out data/dmh.json --fixtures tests/fixtures/dmh   # offline, from fixtures
node tests/e2e/smoke.mjs http://localhost:8080 --quick                     # browser smoke test (needs Playwright)
```

Demo scenarios run the real logic on made-up data, and show a "DEMO" banner:
- `?demo=calm`
- `?demo=watch`
- `?demo=approach`
- `?demo=today`: a replay of 28 Sep 2026

### Layout

```
index.html, css/            page and styles (light/dark, Burmese typography)
js/main.js                  loads data, decides the level, renders, refreshes every 10 min
js/config.js                places, thresholds, sources, contacts
js/dmh.js js/jtwc.js js/gdacs.js js/weather.js   data sources
js/systems.js js/risk.js    storm geometry vs Yangon, attention-level rules
js/map.js js/charts.js js/ui/   map, charts, page sections
js/i18n.js js/i18n/{en,my}/ English and Burmese text
scripts/fetch-dmh.mjs       DMH bulletin fetcher run by GitHub Actions
sw.js, manifest.webmanifest offline support, install to home screen
tests/                      unit tests, fixtures, browser smoke test
vendor/leaflet, fonts/      Leaflet 1.9.4 (BSD-2), Noto Sans Myanmar (OFL)
```

## Limitations

- Computer models underestimate winds near a cyclone's centre, so DMH's stated winds come first.
- Early low-pressure areas often appear in DMH news before any international feed lists them.
- Short emergency numbers (191, 192, 199) work only from phones inside Myanmar. From abroad, a Yangon landline
  `01-xxxxxx` is dialled `+95 1 xxxxxx`.
- Facebook may be blocked in Myanmar. DMH stages are also broadcast on Myanma Radio, City FM, MRTV, MRTV-4 and
  Myawaddy TV, so keep a battery radio.

## Licence

The code is under the Apache License 2.0 (see [LICENSE](LICENSE)). Third-party components:
- Leaflet: BSD-2-Clause (`vendor/leaflet/LICENSE`)
- Noto Sans Myanmar: SIL OFL 1.1 (`fonts/OFL.txt`)
- Data belongs to its providers and is used under their terms (see the table above).
