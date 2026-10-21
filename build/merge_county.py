import json, sys
# usage: merge_county.py out.json file1 file2 ...
out = {}
# Texas Jurisname spelling variants -> Census NAME.upper() used by geo/counties.json
ALIAS = {'ST. CLAIR': 'ST CLAIR', 'ST. JOSEPH': 'ST JOSEPH'}
for p in sys.argv[2:]:
    d = json.load(open(p)); assert d['jobComplete']; rows = d['rows']; assert len(rows) < 3000, (p, len(rows))
    cols = [f['name'] for f in d['schema']['fields']]; cols = [c for c in cols if c != 'pad']; assert cols == ['county','d','reqR','reqD','reqO','retR','retD','retO','eipR','eipD','eipO'], cols
    for r in rows:
        v = [f['v'] for f in r['f']][:len(cols)]; out.setdefault(ALIAS.get(v[0], v[0]), []).append([int(x) for x in v[1:]])
    print(p[-12:], len(rows))
for c in out:  # merge rows that share a day (alias counties), then sort by day
    byd = {}
    for r in out[c]:
        acc = byd.setdefault(r[0], [r[0]] + [0]*9)
        for i in range(1, 10): acc[i] += r[i]
    out[c] = sorted(byd.values())
json.dump(out, open(sys.argv[1], 'w'), separators=(',', ':'))
s = [sum(r[i+1] for rows in out.values() for r in rows) for i in range(9)]
print(sys.argv[1], 'counties', len(out), 'rows', sum(len(v) for v in out.values()), 'sums', s)
