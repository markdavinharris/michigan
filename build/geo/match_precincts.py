#!/usr/bin/env -S python3 -I
"""Match voter-file precinct codes to NYT/RDH 2024 precinct polygons via census-block interior points,
then write one geometry file per county: data/precincts/<COUNTY>.json
  {"w":600,"h":H,"shapes":[{"id":GEOID,"name":..,"d":svgpath,"cx":..,"cy":..,"p":[precinct codes],
                            "dem":..,"rep":..,"tot":..}], "unmatched":[precinct codes with no shape]}
and a match report geo/match_report.json.
"""
import json, math, os, sys, collections
from shapely.geometry import shape, Point
from shapely.strtree import STRtree
from shapely.ops import unary_union

here = os.path.dirname(os.path.abspath(__file__))
nyt = json.load(open(os.path.join(here, 'nyt', 'MI.geojson')))['features']
blocks = json.load(open(os.path.join(here, 'block_pts.json')))
pb = json.load(open(os.path.join(here, 'precinct_blocks.json')))
counties = json.load(open(os.path.join(here, '..', 'data', 'counties.json')))['paths'].keys()
_ALIAS = {}
_pdata = json.load(open(os.path.join(here, '..', 'data', 'precinct_2026.json')))
all_codes = {}
for _c, _rows in _pdata.items(): all_codes.setdefault(_ALIAS.get(_c, _c), set()).update(r[0] for r in _rows)

# county name -> FIPS via the cb county file
import shapefile
sf = shapefile.Reader(os.path.join(here, 'cb_2023_us_county_20m'))
fields = [f[0] for f in sf.fields[1:]]
fips = {r.record[fields.index('NAME')].upper().replace("'", ' ').replace('.', ''): r.record[fields.index('GEOID')] for r in sf.shapeRecords() if r.record[fields.index('STATEFP')] == '26'}
assert set(fips) == set(counties)

# group NYT shapes by county
by_cty = collections.defaultdict(list)
for f in nyt:
    if f['geometry'] is None: continue
    g = shape(f['geometry'])
    if not g.is_valid: g = g.buffer(0)
    by_cty[f['properties']['GEOID'][:5]].append((f['properties'], g))

lat0 = math.radians(44.5); cosl = math.cos(lat0)
report = {'counties': {}, 'total_precincts': 0, 'matched': 0, 'weak': 0, 'unmatched': 0, 'shapes_shared': 0}
outdir = os.path.join(here, '..', 'data', 'precincts'); os.makedirs(outdir, exist_ok=True)

for cty in sorted(counties):
    feats = by_cty[fips[cty]]
    geoms = [g for _, g in feats]
    tree = STRtree(geoms)
    assign = {}   # precinct code -> (GEOID index, score)
    unmatched = []
    for code in all_codes.get(cty, set()) - set(pb.get(cty, {})): unmatched.append(code)  # no census block for any voter
    for code, info in pb.get(cty, {}).items():
        votes = collections.Counter(); tot = 0
        for blk, n in info['blocks']:
            pt = blocks.get(blk)
            if not pt: continue
            P = Point(pt)
            hits = [i for i in tree.query(P) if geoms[i].covers(P)]
            if not hits:
                # nearest polygon within ~300 m
                d = [(geoms[i].distance(P), i) for i in tree.query(P.buffer(0.003))]
                if d: hits = [min(d)[1]]
            if hits: votes[hits[0]] += n
            tot += n
        if not votes: unmatched.append(code); continue
        best, bn = votes.most_common(1)[0]
        assign[code] = (best, bn / tot if tot else 0)
    # invert: shape index -> precinct codes
    inv = collections.defaultdict(list)
    for code, (i, s) in assign.items(): inv[i].append(code)
    # projection fit to the county's polygons
    allg = unary_union(geoms)
    minx, miny, maxx, maxy = allg.bounds
    W = 600; scale = W / ((maxx - minx) * cosl); H = round((maxy - miny) * scale)
    def proj(x, y): return (round((x - minx) * cosl * scale, 1), round((maxy - y) * scale, 1))
    tol = (maxx - minx) / 1500  # degrees; ~0.07% of county width
    shapes = []
    for i, (props, g) in enumerate(feats):
        gs = g.simplify(tol, preserve_topology=True)
        polys = list(gs.geoms) if gs.geom_type == 'MultiPolygon' else [gs]
        d = ''
        for poly in polys:
            for ring in [poly.exterior] + list(poly.interiors):
                pts = [proj(x, y) for x, y in ring.coords]
                dd = [pts[0]]
                for q in pts[1:]:
                    if q != dd[-1]: dd.append(q)
                if len(dd) < 4: continue
                d += 'M' + ' '.join(f'{x} {y}' for x, y in dd) + 'Z'
        c = gs.representative_point(); cx, cy = proj(c.x, c.y)
        shapes.append({'id': props['GEOID'], 'name': props['GEOID'][6:], 'd': d, 'cx': cx, 'cy': cy,
                       'p': sorted(inv.get(i, [])), 'dem': props.get('votes_dem'), 'rep': props.get('votes_rep'), 'tot': props.get('votes_total')})
    json.dump({'w': W, 'h': H, 'shapes': shapes, 'unmatched': sorted(unmatched)}, open(os.path.join(outdir, f'{cty}.json'), 'w'), separators=(',', ':'))
    weak = sum(1 for _, (i, s) in assign.items() if s < 0.6)
    shared = sum(1 for i, codes in inv.items() if len(codes) > 1)
    empty = sum(1 for i in range(len(feats)) if i not in inv)
    report['counties'][cty] = {'precincts': len(pb.get(cty, {})), 'nyt_shapes': len(feats), 'matched': len(assign), 'weak_lt60': weak, 'unmatched': len(unmatched), 'shapes_with_several_precincts': shared, 'shapes_with_no_precinct': empty, 'unmatched_codes': sorted(unmatched)}
    report['total_precincts'] += len(pb.get(cty, {})); report['matched'] += len(assign); report['weak'] += weak; report['unmatched'] += len(unmatched); report['shapes_shared'] += shared
json.dump(report, open(os.path.join(here, 'match_report.json'), 'w'), indent=1)
print({k: v for k, v in report.items() if k != 'counties'})
worst = sorted(report['counties'].items(), key=lambda kv: -(kv[1]['unmatched'] + kv[1]['shapes_with_several_precincts']))[:8]
for k, v in worst: print(k, {kk: vv for kk, vv in v.items() if kk != 'unmatched_codes'})
print('total size MB', sum(os.path.getsize(os.path.join(outdir, f)) for f in os.listdir(outdir)) / 1e6)
