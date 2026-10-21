import json, sys
# usage: merge_precinct.py out.json file1 file2 ...
# Each input is a saved BigQuery result (Query P). Builds {"COUNTY":[["precinct",regR,...,eipO],...]}.
COLS = ['county','precinct','regR','regD','regO','reqR','reqD','reqO','retR','retD','retO','eipR','eipD','eipO']
out = {}
null_pct = 0; blank_pct = 0
for p in sys.argv[2:]:
    d = json.load(open(p)); assert d['jobComplete'], p
    rows = d['rows']; assert len(rows) < 3000, (p, len(rows))
    cols = [f['name'] for f in d['schema']['fields']]; assert cols == COLS, cols
    for r in rows:
        v = [f['v'] for f in r['f']]
        pct = v[1]
        if pct is None: null_pct += 1; pct = ''
        elif pct.strip() == '': blank_pct += 1
        out.setdefault(v[0], []).append([pct] + [int(x) for x in v[2:]])
    print(p[-12:], len(rows))
dups = []
for c in out:
    out[c].sort(key=lambda r: r[0])
    seen = set()
    for r in out[c]:
        if r[0] in seen: dups.append((c, r[0]))
        seen.add(r[0])
json.dump(out, open(sys.argv[1], 'w'), separators=(',', ':'))
s = [sum(r[i+1] for rows in out.values() for r in rows) for i in range(12)]
print(sys.argv[1], 'counties', len(out), 'rows', sum(len(v) for v in out.values()))
print('sums', dict(zip(COLS[2:], s)))
print('null precinct codes', null_pct, 'blank precinct codes', blank_pct, 'dups within county', dups)
