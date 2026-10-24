# How this site updates itself

`.github/workflows/refresh.yml` runs every hour from about 7 AM to 11 PM Eastern (and on demand from the
Actions tab, "Run workflow", tick "force" to rebuild regardless). Each run:

1. checks the state's rows in `coldspark-voterdata.national_file.abev_2026` (a fingerprint, a few cents of
   BigQuery); if nothing changed since the last refresh (`build/feed_fingerprint.txt`) it stops;
2. otherwise re-runs the dashboard queries (same SQL as the Claude build kit's SPEC.md) with `build/ev_refresh.py`,
3. rewrites only the data inside `index.html` (design, county outlines and notes are kept as committed),
4. refuses to publish implausible results (records or early votes going down, the as-of date going backwards,
   2024/2022 totals moving, counties missing) — the run fails, GitHub emails the repo owner, the live page stays,
5. commits, asks Pages to rebuild and checks the live site shows the new build stamp.

State-specific SQL (how a record's county is found) and county-name spellings live in `build/ev_config.json`.
The only credential is the repository secret `GCP_SA_KEY` (BigQuery read-only service account).
To change the page design, edit and push `index.html` (for example the standalone page a Claude refresh
publishes as the artifact file `site/index.html`); the next run keeps the new design and refreshes its data.
