#!/usr/bin/env python3
"""Assemble the Ohio Early Vote dashboard: template.html + data/*.json -> dashboard.html

Usage: python3 build.py [data_dir] [out_file]
Expects in data_dir: daily.json, county_daily_2026.json, county_daily_2024.json,
county_daily_2022.json, precinct_2026.json (formats in SPEC.md).
"""
import json, sys, os, datetime

here = os.path.dirname(os.path.abspath(__file__))
data_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, 'data')
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(here, 'dashboard.html')

ED = {'2026': '2026-11-03', '2024': '2024-11-05', '2022': '2022-11-08'}
STATE = {
    'name': 'Michigan', 'abbr': 'MI', 'fips': '26', 'counties': 83,
    'party_label': 'modeled party', 'other_label': 'Modeled independent', 'no_requests': False,
    'party_note': 'Michigan has no party registration, so party here is ColdSpark’s modeled party for each voter (modeled Republican, modeled Democrat, or modeled independent), from the voter file as it stood in each year.',
    'pacing_note': 'Michigan stores absentee requests made more than 60 days out on a single cutoff date, so the requested line jumps once early in the window rather than showing real daily activity before that. In-person early voting runs for nine days, from the second Saturday before Election Day (Oct 24, 2026) through the Sunday before; Michigan had no statewide early in-person voting in 2022, and the 2024 feed recorded nearly all early-voting-site ballots as absentee ballots returned (only about 26,000 rows carry an in-person date), so compare on mail returned or total early votes rather than the in-person line.',
    'other_note': 'Party is ColdSpark’s modeled party; Michigan has no party registration.',
    'unmatched_pct': None,  # filled from daily.json below
}

def load(name):
    with open(os.path.join(data_dir, name)) as f:
        return json.load(f)

daily = load('daily.json')
county = {y: load(f'county_daily_{y}.json') for y in ('2026', '2024', '2022')}
precinct = load('precinct_2026.json')
heat = {'2026': load('heat_2026.json'), '2022': load('heat_2022.json')}  # party x vote-history cells (Query H)
geo = load('counties.json')  # static: county outlines as SVG paths (made by geo/make_geo.py)

# Michigan county-name normalisation: the voter file writes ST CLAIR / ST JOSEPH without the period the Census uses.
# Everything is keyed on the voter-file spelling; counties.json is built with the same rule.
ALIAS = {'ST. CLAIR': 'ST CLAIR', 'ST. JOSEPH': 'ST JOSEPH'}
def _norm(dct):
    out = {}
    for k, v in dct.items():
        k2 = ALIAS.get(k, k)
        if k2 in out:
            out[k2] = (out[k2] + v) if isinstance(v, list) else {**out[k2], **v}
        else:
            out[k2] = v
    return out
precinct = _norm(precinct)
for y in county: county[y] = _norm(county[y])
for y in heat: heat[y]['data'] = _norm(heat[y]['data'])
# Rows that matched no voter have no county ('UNKNOWN'); they stay in the statewide file but not the county file.
_all = {c for c in precinct}
for y in county: county[y].pop('UNKNOWN', None)
# Counties with no ABEV rows in a year get an empty day list so the county table and map still show them.
for y in county:
    for c in _all - set(county[y]):
        county[y][c] = []

# As-of = last complete day in 2026: smallest d whose returns+EIP exceed 500.
rows26 = sorted(daily['2026']['rows'])
asof_d = None
for r in rows26:
    if sum(r[4:10]) > 500:
        asof_d = r[0]; break
if asof_d is None:
    raise SystemExit('could not determine as-of day')
ed26 = datetime.date.fromisoformat(ED['2026'])
asof_date = ed26 - datetime.timedelta(days=asof_d)

# Partial-day rows dropped from headline figures (d < asof_d)
partial = [r for r in rows26 if r[0] < asof_d]
partial_tot = [sum(r[i] for r in partial) for i in range(1, 10)]

# Sanity: county sums should match statewide
for y in county:
    s = [0]*9
    for rows in county[y].values():
        for r in rows:
            for i in range(9): s[i] += r[i+1]
    t = [sum(r[i+1] for r in daily[y]['rows']) for i in range(9)]
    if s != t:
        print(f'WARNING {y}: county sums {s} != statewide {t}', file=sys.stderr)
assert len(precinct) == STATE['counties'] and all(len(county[y]) == STATE['counties'] for y in county)
STATE['unmatched_pct'] = round(100 * daily['2026']['unmatched_rows'] / daily['2026']['rows_total'], 1)

payload = {
    'ed': ED,
    'asof': {'d': asof_d, 'date': asof_date.isoformat()},
    'partial': partial_tot,
    'meta': {y: {k: v for k, v in daily[y].items() if k != 'rows'} for y in daily},
    'daily': {y: sorted(daily[y]['rows']) for y in daily},
    'county': county,
    'precinct': precinct,
    'heat': heat,
    'geo': geo,
    'state': STATE,
    'built': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC'),
}

with open(os.path.join(here, 'template.html')) as f:
    tpl = f.read()
js = json.dumps(payload, separators=(',', ':')).replace('</', '<\\/')
assert '/*__DATA__*/' in tpl and '/*__JS__*/' in tpl
with open(os.path.join(here, 'app.js')) as f:
    appjs = f.read()
html = tpl.replace('/*__DATA__*/', js).replace('/*__JS__*/', appjs).replace('__TITLE__', STATE['name'] + ' Early Vote 2026').replace('__STATE__', STATE['name']).replace('__PARTY_LABEL__', STATE.get('party_label','registered party')).replace('__OTHER_NOTE__', STATE.get('other_note','Other / unaffiliated includes voters with no party on file.'))
with open(out, 'w') as f:
    f.write(html)
# Standalone copy for self-hosting (the artifact adds its own document skeleton; a web host does not)
cut = html.index('<header class="mast">')
head, body = html[:cut], html[cut:]
standalone = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
              '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
              '<meta name="description" content="' + STATE['name'] + ' 2026 mail and early in-person vote tracker from ColdSpark: pacing against 2024 and 2022, partisan split, and county and precinct detail, updated daily.">\n'
              + head.replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '')
              + '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}img{max-width:100%}[hidden]{display:none!important}</style>\n'
              '</head>\n<body>\n' + body + '\n</body>\n</html>\n')
with open(os.path.join(os.path.dirname(out), 'index.html'), 'w') as f:
    f.write(standalone)
print(f'wrote {out} ({len(html)/1e6:.2f} MB); as of {asof_date} (d={asof_d}); partial-day rows dropped: {partial_tot}')
