# Michigan Early Vote 2026 dashboard — daily refresh runbook

Published artifact (update in place, never create a new one):
**https://claude.ai/artifact/KJsVP8nYphYhtJKEzGhd5d** — title "Michigan Early Vote 2026".

The page is a single self-contained HTML file built by `build.py` from `template.html`, `app.js`, seven JSON
data files and one static geometry file `data/counties.json` (Michigan county outlines as SVG paths, made once from
the Census cb_2023_us_county_20m shapefile by `geo/make_geo.py`; it never changes). All source files plus `SPEC.md`,
the merge helpers and `counties.json` are stored in this Project under `claude/michigan-ev-dashboard/`.

## Steps (about 20 minutes; the BigQuery queries are the slow part)

1. Make a working folder in the scratchpad, e.g. `michigan/` with a `data/` subfolder. Fetch the project docs
   `claude/michigan-ev-dashboard/{SPEC.md,build.py,template.html,app.js,merge_county.py,merge_precinct.py,heat_merge.py,counties.json,REFRESH.md}`
   with `project_read` and write each to the working folder under its own file name (`build.py` expects
   `template.html` and `app.js` beside it, and `counties.json` inside `data/` with the query outputs).
2. Re-run the queries in `SPEC.md`. Only 2026 data changes day to day, but `voters` is rebuilt occasionally, so
   re-run everything each time. Run the queries yourself with `mcp__Google_Cloud_BigQuery__execute_sql_readonly`
   (parameter name is `query`). Every result must be SAVED TO A FILE by the harness (automatic for large results;
   add a `REPEAT('x',10000) pad` column to small ones such as Query S), then converted with the helper scripts —
   never retype numbers:
   - `daily.json`: Query S ×3 years (+ pad) and the totals query → a short Python script (as in the 2026-10-21 run)
   - `county_daily_{2026,2024,2022}.json`: Query C in 4 county chunks each → `merge_county.py out.json c1 c2 c3 c4`
   - `heat_2026.json`, `heat_2022.json`: Query H, one query each (ASOF = the as-of day; 15 on 2026-10-21) → `heat_merge.py out.json result`
   - `precinct_2026.json`: Query P in 2 chunks → `merge_precinct.py out.json c1 c2`
   Cross-check: build.py WARNs that county sums differ from statewide — that is EXPECTED for Michigan, because the
   rows that matched no voter (UNKNOWN county, about 4,000 in 2026) are in the statewide file only. Any other
   difference is a problem.
3. `python3 build.py` → `dashboard.html` and `index.html`. It prints the as-of date (last complete day).
4. Spot-check one number independently, e.g.
   `SELECT COUNTIF(Rejected=0 AND ReturnDate BETWEEN '2026-01-01' AND '<asof>') + COUNTIF(EarlyVoted BETWEEN '2026-01-01' AND '<asof>') FROM abev_2026 WHERE State='MI'`
   should equal the "Early votes cast" tile within a few dozen (the dashboard window drops returns dated more than 60 days out; 788,783 vs 788,801 on 2026-10-21).
5. Screenshot once with Playwright (`shot.py`, light, 1200 wide) and look at it; then publish with the Artifact tool:
   `action: publish`, `url: https://claude.ai/artifact/KJsVP8nYphYhtJKEzGhd5d`, `file_path: <dashboard.html>`,
   `label: "Data through <as-of date>"`, and `files: {"site/index.html": {"from": "<abs path to index.html>", "contentType": "text/html"}}`.
   Read the artifact first if the tool says it has not been read in this conversation. Do not pass `icon`.
   A publish that passes only these keeps the 83 `precincts/*.json` files already on the artifact.
6. If `template.html` or `app.js` had to change, write the changed file back to the Project at the same path
   (the Ohio, Iowa, Texas and Michigan kits share them; only `build.py`'s STATE block differs).
7. Report: as-of date, statewide early votes (and change vs 2024 same point), net R−D, anything odd.

## Data notes that matter
- Michigan has no party registration: party = `PartyRollUp` modeled labels (`Modeled Republican` / `Modeled Democrat` /
  `Modeled Independent/Unaffiliated`), from the voter file of each year. The ABEV party flags are all zero in MI.
- **ABEV `Jurisname` in Michigan is the city or township (1,310 of them), not the county.** County comes from the
  voter file (`IFNULL(UPPER(v.CountyName),'UNKNOWN')` in the CTE), so rows with no matching voter have no county.
- Requests are capped at the 60-day cutoff (2026-09-04); ballots mail out about 40 days before Election Day.
- Early in-person voting: 9 days, Oct 24 – Nov 1, 2026. There was none statewide in 2022. In 2024 the feed recorded
  nearly all early-voting-site ballots as absentee returns (only ~26,000 rows carry an `EarlyVoted` date), so the
  in-person tiles and lines are small for 2024; compare on mail returned / total early votes.
- Rejected rows: ~19,000 in each year; excluded from request/return counts as usual.
- County spelling: voter file ST CLAIR / ST JOSEPH (no period); `make_geo.py` strips the Census period so
  `counties.json` matches, and `merge_county.py` / `heat_merge.py` / `build.py` map the dotted form if it appears.
- Unmatched ABEV rows (no voter in `voters`): 3,983 of 2,128,231 in 2026 (0.2%), counted as modeled independent statewide.

## Precinct maps
83 files on the artifact (`precincts/<COUNTY>.json`, spaces as underscores; 1.7 MB total), built once by
`geo/match_precincts.py` from the NYT 2024 precinct map (`MI-precincts-with-results.geojson.gz`, 3,997 shapes) matched to
`voters.PrecinctCode` via each precinct's top-8 Census 2020 blocks (`voter_contact.CensusBlock2020`, STRING_AGG query in
2 county chunks; interior points from TIGER `tl_2020_26_tabblock20.dbf`). Result on 2026-10-21: all 3,899 codes
placed; 234 weak (<60% of voters' blocks inside the shape; 60 of them in Oakland); 79 shapes hold several codes.
Rebuild only if Michigan precinct codes change materially.

## Public site
No GitHub Pages site yet for Michigan. If one is set up (e.g. michigan.coldspark.com), follow `claude/early-vote-sites-publish.md`:
the standalone page is published on the artifact as `site/index.html` by step 5 above, and the device-bound task pulls it from there.
