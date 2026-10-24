#!/usr/bin/env python3
"""Refresh an early-vote site's data straight from BigQuery and rewrite index.html in place.

Runs in GitHub Actions (see .github/workflows/refresh.yml). No Claude session is involved.

What it does, for the state named in ev_config.json:
  1. Cheap feed probe: fingerprints the state's abev_2026 rows. If the fingerprint matches the one recorded
     on the last successful refresh (build/feed_fingerprint.txt), it stops: nothing new to publish.
  2. Runs the same queries as the kit's SPEC.md (Query S/C/P/H plus totals), without the 3,000-row chunking
     the chat connector needed.
  3. Applies the same normalisation as the kit (merge_*.py + build.py): county aliases, UNKNOWN / unmapped
     counties dropped from the county views, counties with no rows filled with [], as-of = smallest d whose
     returns + in-person votes exceed 500, partial later days held back.
  4. Replaces only the data object (`const D = {...};`) inside the existing index.html, so the page design
     (template + app.js) is whatever was last committed. Static parts (county outlines, state notes) are kept.
  5. Refuses to publish on implausible results (see sanity checks) — the workflow then fails and GitHub
     emails the repo owner; the live page stays on the last good data.
  6. Optional (ev_config "projection": true): recomputes the gated "Projected final electorate" panel with the kit's
     model (build/make_proj.py, Query M x3 at the page's as-of day) and replaces `const P = ...;` in the page. If that
     step fails, the panel is hidden (P = null) rather than left stale, and the rest of the refresh still publishes.

Usage: python3 ev_refresh.py --config build/ev_config.json --page index.html [--fingerprint build/feed_fingerprint.txt] [--force]
Exit codes: 0 = page updated or nothing new; 1 = error / sanity check failed (page untouched).
"""
import argparse, datetime, json, os, sys, time

ED = {'2026': '2026-11-03', '2024': '2024-11-05', '2022': '2022-11-08'}
TABLES = {'2026': ('abev_2026', 'voters'), '2024': ('abev_2024', 'voterfile_2024'), '2022': ('abev_2022', 'voterfile_2022')}
PROJECT = 'coldspark-voterdata'
DS = f'{PROJECT}.national_file'
PARTY = ("CASE WHEN {v}.PartyRollUp IN ('Republican','Modeled Republican') THEN 'R' "
         "WHEN {v}.PartyRollUp IN ('Democrat','Modeled Democrat') THEN 'D' ELSE 'O' END")
NINE = ("COUNTIF(m='req' AND party='R') reqR, COUNTIF(m='req' AND party='D') reqD, COUNTIF(m='req' AND party='O') reqO, "
        "COUNTIF(m='ret' AND party='R') retR, COUNTIF(m='ret' AND party='D') retD, COUNTIF(m='ret' AND party='O') retO, "
        "COUNTIF(m='eip' AND party='R') eipR, COUNTIF(m='eip' AND party='D') eipD, COUNTIF(m='eip' AND party='O') eipO")


def q_proj(cfg, year, asof):
    """Query M of the kits' PROJECTION.md: projection cells (ModeledParty x habit x freq x primary) for one year."""
    st = cfg['state']
    if year == '2022':
        ab, vf, ed = 'abev_2022', 'voters', ED['2022']
        g, pr, fin, reg, having = ('VH20G', 'VH18G', 'VH16G'), 'COALESCE(VH22P,VH20P)', 'VH22G IS NOT NULL OR a.dbe IS NOT NULL', ' AND (f.RegistrationYear IS NULL OR f.RegistrationYear<=2022)', 'BETWEEN 0 AND 60'
    elif year == '2024':
        ab, vf, ed = 'abev_2024', 'voterfile_2024', ED['2024']
        g, pr, fin, reg, having = ('VH22G', 'VH20G', 'VH18G'), 'COALESCE(VH24P,VH22P)', 'VH24G IS NOT NULL OR a.dbe IS NOT NULL', '', 'BETWEEN 0 AND 60'
    else:
        ab, vf, ed = 'abev_2026', 'voters', ED['2026']
        g, pr, fin, reg, having = ('VH24G', 'VH22G', 'VH20G'), 'COALESCE(VH26P,VH24P)', 'FALSE', '', f'BETWEEN {asof} AND 60'
    return f"""WITH a AS (
  SELECT DT_Regid, MAX(DATE_DIFF(DATE '{ed}', LEAST(IFNULL(EarlyVoted, DATE '2099-01-01'), IFNULL(IF(Rejected=0, ReturnDate, NULL), DATE '2099-01-01')), DAY)) dbe
  FROM `{DS}.{ab}`
  WHERE State='{st}' AND (EarlyVoted IS NOT NULL OR (ReturnDate IS NOT NULL AND Rejected=0)) AND DT_Regid<>''
  GROUP BY 1 HAVING dbe {having}
), v AS (
  SELECT f.State st, f.ModeledParty party,
   CASE WHEN {g[0]} IN ('2','7') THEN 'E' WHEN {g[0]}='1' THEN 'D' WHEN {g[1]} IN ('2','7') THEN 'E' WHEN {g[1]}='1' THEN 'D' ELSE 'N' END habit,
   IF({g[0]} IS NOT NULL,1,0)+IF({g[1]} IS NOT NULL,1,0)+IF({g[2]} IS NOT NULL,1,0) freq,
   CASE WHEN {pr} IN ('3','4','8') THEN 'R' WHEN {pr} IN ('5','6','9') THEN 'D' ELSE 'N' END prim,
   {fin} fin, a.dbe
  FROM `{DS}.{vf}` f LEFT JOIN a USING (DT_Regid)
  WHERE f.State='{st}'{reg})
SELECT st, party, habit, freq, prim, COUNT(*) n, COUNTIF(fin) fin, COUNTIF(dbe>={asof}) e{asof}
FROM v GROUP BY 1,2,3,4,5"""


def compute_projection(bq, cfg, asof):
    """Run Query M for 2022/2024/2026 and the kit's model; returns the proj dict the page's panel reads."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import make_proj
    cols = ['st', 'party', 'habit', 'freq', 'prim', 'n', 'fin', f'e{asof}']
    cells = {y: make_proj.frame(cols, bq.rows(q_proj(cfg, y, asof), f'projection cells {y}'), cfg['state'])
             for y in ('2022', '2024', '2026')}
    res = make_proj.compute({'2022': cells['2022'], '2024': cells['2024']}, cells['2026'], cfg['state'], asof)
    log(f"  projection as of d={asof}: early {res['early_net']:+.1f} -> projected {res['proj_net']:+.1f} "
        f"({res['net_lo']:+.1f}..{res['net_hi']:+.1f}); {res['early_votes']:,} early votes")
    return res


def find_proj(html):
    """Locate the projection object (`const P = {...}` or `null`) in the page; None if the page has no panel."""
    marker = 'const P = '
    if marker not in html:
        return None
    j = html.index(marker) + len(marker)
    if html.startswith('null', j):
        return j, j + 4, None
    P, e = json.JSONDecoder().raw_decode(html, j)
    return j, e, P


def log(*a):
    print(*a, flush=True)


class BQ:
    def __init__(self):
        from google.cloud import bigquery  # imported here so --selftest runs without the package
        self.bq = bigquery
        self.client = bigquery.Client(project=PROJECT)
        self.bytes = 0

    def rows(self, sql, label):
        last = None
        for attempt in range(4):
            try:
                t = time.time()
                job = self.client.query(sql, job_config=self.bq.QueryJobConfig(labels={'source': 'ev-sites-github'}))
                res = [list(r.values()) for r in job.result(timeout=900)]
                self.bytes += job.total_bytes_processed or 0
                log(f'  {label}: {len(res):,} rows, {((job.total_bytes_processed or 0)/1e9):.2f} GB, {time.time()-t:.0f}s')
                return res
            except Exception as e:  # transient BigQuery / network errors: back off and retry
                last = e
                log(f'  {label}: attempt {attempt+1} failed: {e}')
                time.sleep(15 * (attempt + 1))
        raise RuntimeError(f'{label} failed after retries: {last}')


def cte(cfg, year):
    abev, vf = TABLES[year]
    st = cfg['state']
    return f"""WITH a AS (
  SELECT IFNULL({cfg['county_expr']}, 'UNKNOWN') AS county,
    a.RequestDate, a.ReturnDate, a.EarlyVoted, a.Rejected, {PARTY.format(v='v')} AS party
  FROM `{DS}.{abev}` a
  LEFT JOIN `{DS}.{vf}` v ON v.DT_Regid = a.DT_Regid AND v.State = '{st}'
  WHERE a.State = '{st}'
),
u AS (
  SELECT county, 'req' AS m, DATE_DIFF(DATE '{ED[year]}', RequestDate, DAY) AS d, party FROM a
    WHERE Rejected = 0 AND RequestDate BETWEEN DATE '{year}-01-01' AND DATE '{year}-12-31'
  UNION ALL SELECT county, 'ret', DATE_DIFF(DATE '{ED[year]}', ReturnDate, DAY), party FROM a
    WHERE Rejected = 0 AND ReturnDate BETWEEN DATE '{year}-01-01' AND DATE '{year}-12-31'
  UNION ALL SELECT county, 'eip', DATE_DIFF(DATE '{ED[year]}', EarlyVoted, DAY), party FROM a
    WHERE EarlyVoted BETWEEN DATE '{year}-01-01' AND DATE '{year}-12-31'
)"""


def q_county(cfg, year):
    return cte(cfg, year) + f"\nSELECT county, d, {NINE}\nFROM u WHERE d BETWEEN -14 AND 60 GROUP BY county, d ORDER BY county, d"


def q_totals(cfg, year):
    abev, vf = TABLES[year]
    st = cfg['state']
    return (f"SELECT COUNT(*) rows_total, COUNTIF(a.Rejected=1) rejected_rows, COUNTIF(v.DT_Regid IS NULL) unmatched_rows "
            f"FROM `{DS}.{abev}` a LEFT JOIN `{DS}.{vf}` v ON v.DT_Regid = a.DT_Regid AND v.State = '{st}' WHERE a.State = '{st}'")


def q_precinct(cfg):
    st = cfg['state']
    return f"""SELECT UPPER(v.CountyName) county, v.PrecinctCode precinct,
  COUNTIF(party='R') regR, COUNTIF(party='D') regD, COUNTIF(party='O') regO,
  COUNTIF(a.Rejected=0 AND a.RequestDate IS NOT NULL AND party='R') reqR,
  COUNTIF(a.Rejected=0 AND a.RequestDate IS NOT NULL AND party='D') reqD,
  COUNTIF(a.Rejected=0 AND a.RequestDate IS NOT NULL AND party='O') reqO,
  COUNTIF(a.Rejected=0 AND a.ReturnDate IS NOT NULL AND party='R') retR,
  COUNTIF(a.Rejected=0 AND a.ReturnDate IS NOT NULL AND party='D') retD,
  COUNTIF(a.Rejected=0 AND a.ReturnDate IS NOT NULL AND party='O') retO,
  COUNTIF(a.EarlyVoted IS NOT NULL AND party='R') eipR,
  COUNTIF(a.EarlyVoted IS NOT NULL AND party='D') eipD,
  COUNTIF(a.EarlyVoted IS NOT NULL AND party='O') eipO
FROM (
  SELECT DT_Regid, CountyName, PrecinctCode, {PARTY.format(v='voters')} AS party
  FROM `{DS}.voters` voters WHERE State='{st}'
) v
LEFT JOIN `{DS}.abev_2026` a ON a.DT_Regid = v.DT_Regid AND a.State='{st}'
GROUP BY 1,2 ORDER BY 1,2"""


def q_heat(cfg, year, asof):
    st = cfg['state']
    if year == '2026':
        hist = "IF(v.VH18G IS NOT NULL,1,0)+IF(v.VH20G IS NOT NULL,1,0)+IF(v.VH22G IS NOT NULL,1,0)+IF(v.VH24G IS NOT NULL,1,0)"
        vf, abev, extra = 'voters', 'abev_2026', ''
    else:
        hist = "IF(v.VH14G IS NOT NULL,1,0)+IF(v.VH16G IS NOT NULL,1,0)+IF(v.VH18G IS NOT NULL,1,0)+IF(v.VH20G IS NOT NULL,1,0)"
        vf, abev = 'voterfile_2022', 'abev_2022'
        extra = (",\n  COUNTIF((a.Rejected=0 AND a.ReturnDate BETWEEN DATE '2022-01-01' AND DATE '2022-12-31') "
                 "OR a.EarlyVoted BETWEEN DATE '2022-01-01' AND DATE '2022-12-31') ev_final,\n  COUNTIF(v.VH22G IS NOT NULL) voted22")
    y, ed = year, ED[year]
    cut = f"DATE_SUB(DATE '{ed}', INTERVAL {int(asof)} DAY)"
    return f"""SELECT UPPER(v.CountyName) county, {PARTY.format(v='v')} party, ({hist}) hist,
  COUNT(*) reg,
  COUNTIF((a.Rejected=0 AND a.ReturnDate BETWEEN DATE '{y}-01-01' AND {cut}) OR a.EarlyVoted BETWEEN DATE '{y}-01-01' AND {cut}) ev_now,
  COUNTIF(a.Rejected=0 AND a.ReturnDate BETWEEN DATE '{y}-01-01' AND {cut}) mail_now,
  COUNTIF(a.EarlyVoted BETWEEN DATE '{y}-01-01' AND {cut}) eip_now,
  COUNTIF(a.Rejected=0 AND a.RequestDate BETWEEN DATE '{y}-01-01' AND {cut}) req_now{extra}
FROM `{DS}.{vf}` v
LEFT JOIN `{DS}.{abev}` a ON a.DT_Regid = v.DT_Regid AND a.State='{st}'
WHERE v.State='{st}' GROUP BY 1,2,3 ORDER BY 1,2,3"""


def q_probe(cfg):
    st = cfg['state']
    return f"""SELECT COUNT(*) n, COUNTIF(EarlyVoted IS NOT NULL) eip, COUNTIF(ReturnDate IS NOT NULL) ret,
  COUNTIF(RequestDate IS NOT NULL) req, COUNTIF(Rejected=1) rej,
  CAST(MAX(IF(EarlyVoted <= CURRENT_DATE(), EarlyVoted, NULL)) AS STRING) max_eip,
  CAST(MAX(IF(ReturnDate <= CURRENT_DATE(), ReturnDate, NULL)) AS STRING) max_ret,
  BIT_XOR(FARM_FINGERPRINT(CONCAT(IFNULL(DT_Regid,''),'|',IFNULL(Jurisname,''),'|',IFNULL(CAST(RequestDate AS STRING),''),'|',
    IFNULL(CAST(ReturnDate AS STRING),''),'|',IFNULL(CAST(EarlyVoted AS STRING),''),'|',CAST(Rejected AS STRING)))) fp,
  (SELECT COUNT(*) FROM `{DS}.voters` WHERE State='{st}') voters_n
FROM `{DS}.abev_2026` WHERE State='{st}'"""


# ---------------------------------------------------------------- transforms (pure; covered by --selftest)

def norm_county(raw, alias, keep):
    """raw: rows [county, d, 9 counts] -> ({COUNTY: [[d, 9 counts], ...]}, dropped totals)."""
    out, dropped = {}, {}
    for r in raw:
        c = alias.get(r[0], r[0])
        tgt = out if c in keep else dropped
        byd = tgt.setdefault(c, {})
        acc = byd.setdefault(int(r[1]), [int(r[1])] + [0] * 9)
        for i in range(9):
            acc[i + 1] += int(r[i + 2])
    res = {c: sorted(out.get(c, {}).values()) for c in sorted(keep)}
    return res, {c: sum(sum(x[1:]) for x in v.values()) for c, v in dropped.items()}


def statewide(raw):
    byd = {}
    for r in raw:
        acc = byd.setdefault(int(r[1]), [int(r[1])] + [0] * 9)
        for i in range(9):
            acc[i + 1] += int(r[i + 2])
    return sorted(byd.values())


def norm_precinct(raw, alias, keep):
    out, dropped = {}, 0
    for r in raw:
        c = alias.get(r[0], r[0]) if r[0] is not None else None
        if c not in keep:
            dropped += sum(int(x) for x in r[2:5]); continue
        code = '' if r[1] is None else r[1]
        out.setdefault(c, []).append([code] + [int(x) for x in r[2:]])
    for c in out:
        out[c].sort(key=lambda x: x[0])
    return out, dropped


def norm_heat(raw, cols, alias, keep):
    out = {}
    for r in raw:
        c = alias.get(r[0], r[0]) if r[0] is not None else None
        if c not in keep:
            continue
        out.setdefault(c, {}).setdefault(r[1], []).append([int(x) for x in r[2:]])
    return {'cols': cols, 'data': out}


def asof_of(rows26):
    for r in sorted(rows26):
        if sum(r[4:10]) > 500:
            return r[0]
    return None


def built_stamp():
    """Build time in US Eastern, e.g. 'Oct 24, 2026 9:05 AM ET'."""
    try:
        from zoneinfo import ZoneInfo
        now = datetime.datetime.now(ZoneInfo('America/New_York'))
    except Exception:  # no tz database: fixed offset fallback (EDT until Nov 1, EST after)
        utc = datetime.datetime.now(datetime.timezone.utc)
        now = utc + datetime.timedelta(hours=-4 if utc < datetime.datetime(2026, 11, 1, 6, tzinfo=datetime.timezone.utc) else -5)
    return now.strftime('%b ') + str(now.day) + now.strftime(', %Y ') + now.strftime('%I:%M %p').lstrip('0') + ' ET'


def read_page(path):
    html = open(path, encoding='utf-8').read()
    marker = 'const D = '
    i = html.index(marker) + len(marker)
    D, end = json.JSONDecoder().raw_decode(html, i)
    return html, D, i, end


def dump_data(D):
    return json.dumps(D, separators=(',', ':')).replace('</', '<\\/')


# ---------------------------------------------------------------- main
PJ = None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--config', required=True)
    ap.add_argument('--page', required=True)
    ap.add_argument('--fingerprint', default=None)
    ap.add_argument('--force', action='store_true', help='rebuild and rewrite the page even if the feed and data have not changed')
    ap.add_argument('--selftest', action='store_true', help='check the transforms against the current page, no BigQuery')
    args = ap.parse_args()
    cfg = json.load(open(args.config))
    alias = cfg.get('alias', {})
    html, old, i, end = read_page(args.page)
    assert html[i:end] == dump_data(old), 'page data does not round-trip; refusing to rewrite it'
    keep = set(old['geo']['paths'])
    log(f"{cfg['state']}: page as of {old['asof']['date']} (built {old['built']}), {len(keep)} counties")

    if args.selftest:
        global PJ
        PJ = find_proj(html)
        if PJ and PJ[2] is not None:
            assert html[PJ[0]:PJ[1]] == dump_data(PJ[2]), 'projection object does not round-trip'
        selftest(old, alias, keep)
        return 0

    bq = BQ()
    fp_path = args.fingerprint
    probe = bq.rows(q_probe(cfg), 'feed probe')[0]
    fp = json.dumps(probe, default=str)
    if fp_path and os.path.exists(fp_path) and open(fp_path).read().strip() == fp and not args.force:
        log(f'feed unchanged since last refresh ({probe}); nothing to do')
        return 0
    log(f'feed: {probe}')

    D = json.loads(json.dumps(old))  # deep copy; static parts carried over
    daily, county = {}, {}
    for y in ('2026', '2024', '2022'):
        raw = bq.rows(q_county(cfg, y), f'county daily {y}')
        tot = bq.rows(q_totals(cfg, y), f'totals {y}')[0]
        daily[y] = {'rows': statewide(raw), 'rows_total': int(tot[0]), 'rejected_rows': int(tot[1]), 'unmatched_rows': int(tot[2])}
        county[y], dropped = norm_county(raw, alias, keep)
        unexpected = {c: n for c, n in dropped.items() if c not in ('UNKNOWN',)}
        if dropped:
            log(f'  {y}: rows outside the county map (kept statewide only): {dropped}')
        if unexpected and sum(unexpected.values()) > 0.002 * sum(sum(r[1:]) for r in daily[y]['rows']):
            raise SystemExit(f'SANITY: {y} has unmapped county names carrying real volume: {unexpected} (add them to alias in ev_config.json)')
    asof_d = asof_of(daily['2026']['rows'])
    if asof_d is None:
        raise SystemExit('SANITY: could not determine the as-of day')
    raw_p = bq.rows(q_precinct(cfg), 'precinct 2026')
    precinct, pdrop = norm_precinct(raw_p, alias, keep)
    if pdrop:
        log(f'  precinct: {pdrop:,} registered voters with no/unmapped county left out')
    heat = {
        '2026': norm_heat(bq.rows(q_heat(cfg, '2026', asof_d), 'heat 2026'), ['hist', 'reg', 'ev_now', 'mail_now', 'eip_now', 'req_now'], alias, keep),
        '2022': norm_heat(bq.rows(q_heat(cfg, '2022', asof_d), 'heat 2022'), ['hist', 'reg', 'ev_now', 'mail_now', 'eip_now', 'req_now', 'ev_final', 'voted22'], alias, keep),
    }

    proj_old = find_proj(html)
    proj = proj_old[2] if proj_old else None
    if cfg.get('projection'):
        if not proj_old:
            log('  projection: page has no projection panel (const P); skipping')
        else:
            try:
                proj = compute_projection(bq, cfg, asof_d)
                if proj['dbe'] != asof_d:
                    raise ValueError(f"projection day {proj['dbe']} != page day {asof_d}")
            except Exception as e:
                log(f'::warning::projection step failed, panel hidden: {e}')
                proj = None

    rows26 = sorted(daily['2026']['rows'])
    asof_date = datetime.date.fromisoformat(ED['2026']) - datetime.timedelta(days=asof_d)
    partial = [r for r in rows26 if r[0] < asof_d]
    D['asof'] = {'d': asof_d, 'date': asof_date.isoformat()}
    D['partial'] = [sum(r[k] for r in partial) for k in range(1, 10)]
    D['meta'] = {y: {k: v for k, v in daily[y].items() if k != 'rows'} for y in daily}
    D['daily'] = {y: sorted(daily[y]['rows']) for y in daily}
    D['county'] = county
    D['precinct'] = precinct
    D['heat'] = heat
    D['state']['unmatched_pct'] = round(100 * daily['2026']['unmatched_rows'] / daily['2026']['rows_total'], 1)

    # ---- sanity checks against the page that is live now
    problems = []
    om, nm = old['meta'], D['meta']
    if nm['2026']['rows_total'] < 0.97 * om['2026']['rows_total']:
        problems.append(f"2026 records fell from {om['2026']['rows_total']:,} to {nm['2026']['rows_total']:,}")
    for y in ('2024', '2022'):
        if abs(nm[y]['rows_total'] - om[y]['rows_total']) > 0.01 * om[y]['rows_total']:
            problems.append(f"{y} records changed from {om[y]['rows_total']:,} to {nm[y]['rows_total']:,} (static table)")
    if asof_date.isoformat() < old['asof']['date']:
        problems.append(f"as-of date would go backwards ({old['asof']['date']} -> {asof_date})")
    if len(precinct) < 0.95 * len(keep):
        problems.append(f'only {len(precinct)} of {len(keep)} counties have precinct rows')
    for y in ('2026', '2022'):
        if len(heat[y]['data']) < 0.95 * len(keep):
            problems.append(f'heat {y}: only {len(heat[y]["data"])} counties')
    ev = lambda rows: sum(sum(r[4:10]) for r in rows)
    old_ev = ev([r for r in old['daily']['2026'] if r[0] >= old['asof']['d']])
    new_ev = ev([r for r in D['daily']['2026'] if r[0] >= asof_d])
    if new_ev < 0.97 * old_ev:
        problems.append(f'2026 early votes fell from {old_ev:,} to {new_ev:,}')
    for y in ('2024', '2022'):
        o, n = ev(old['daily'][y]), ev(D['daily'][y])
        if abs(n - o) > 0.01 * max(o, 1):
            problems.append(f'{y} early votes changed from {o:,} to {n:,} (static table)')
    if problems:
        log('SANITY CHECKS FAILED; page left unchanged:\n  - ' + '\n  - '.join(problems))
        return 1

    same = all(D[k] == old[k] for k in ('asof', 'partial', 'meta', 'daily', 'county', 'precinct', 'heat'))
    if proj_old and proj != proj_old[2]:
        same = False
    if same and not args.force:
        log('data identical to the live page; not rewriting')
    else:
        D['built'] = built_stamp()
        parts = [(i, end, dump_data(D))]
        if proj_old:
            parts.append((proj_old[0], proj_old[1], dump_data(proj) if proj else 'null'))
        out = html
        for a, b, txt in sorted(parts, reverse=True):  # replace from the end so earlier offsets stay valid
            out = out[:a] + txt + out[b:]
        with open(args.page, 'w', encoding='utf-8') as f:
            f.write(out)
        log(f"wrote {args.page}: as of {asof_date} (d={asof_d}); 2026 early votes {new_ev:,} (was {old_ev:,}); built {D['built']}")
        gh_out = os.environ.get('GITHUB_OUTPUT')
        if gh_out:
            with open(gh_out, 'a') as f:
                f.write(f'asof={asof_date}\nchanged=true\n')
    if fp_path:
        with open(fp_path, 'w') as f:
            f.write(fp + '\n')
    log(f'BigQuery bytes processed this run: {bq.bytes/1e9:.1f} GB')
    return 0


def selftest(old, alias, keep):
    """Rebuild county/statewide/precinct/heat structures from the page's own numbers via the same transforms."""
    for y in ('2026', '2024', '2022'):
        raw = [[c, *r] for c, rows in old['county'][y].items() for r in rows]
        c2, dropped = norm_county(raw, alias, keep)
        assert c2 == old['county'][y], f'county {y} mismatch'
        assert not dropped
        sw = statewide(raw)
        diff = [a - b for a, b in zip([sum(r[k] for r in sw) for k in range(1, 10)], [sum(r[k] for r in old['daily'][y]) for k in range(1, 10)])]
        log(f'  {y}: county transform round-trips; statewide minus county-sum difference (UNKNOWN rows) {diff}')
    rawp = [[c, *r] for c, rows in old['precinct'].items() for r in rows]
    p2, _ = norm_precinct(rawp, alias, keep)
    assert p2 == old['precinct'], 'precinct mismatch'
    for y in ('2026', '2022'):
        rawh = [[c, p, *r] for c, ps in old['heat'][y]['data'].items() for p, rows in ps.items() for r in rows]
        h2 = norm_heat(rawh, old['heat'][y]['cols'], alias, keep)
        assert h2 == old['heat'][y], f'heat {y} mismatch'
    a = asof_of(old['daily']['2026'])
    log('  projection panel: ' + ('none on this page' if not PJ else ('hidden (null)' if PJ[2] is None else f"as of d={PJ[2]['dbe']}")))
    assert a == old['asof']['d'], (a, old['asof'])
    log('selftest OK')


if __name__ == '__main__':
    sys.exit(main())
