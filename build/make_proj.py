#!/usr/bin/env python3
"""Projected final electorate (Query M in SPEC.md) -> data/proj.json

Usage: python3 make_proj.py OUT.json STATE ASOF RESULT_2022 RESULT_2024 RESULT_2026
  RESULT_* are the saved BigQuery result files of Query M for 2022 (current voters file, registered <= 2022),
  2024 (voterfile_2024) and 2026 (voters). ASOF is days before Election Day of the latest complete 2026 day.
Model: for each cell (ModeledParty x early/ED habit x recent generals voted x primary party), the chance a voter
who has not voted by day ASOF still votes is taken from the training year (shrunk toward coarser cells), scaled by
(this year's early rate in the cell / the training year's)^alpha. Central = train 2022, alpha 0.5. Range = min/max
over train {2022, 2024} x alpha {0.25, 0.5, 0.75}. Backtest (2022<->2024 at ASOF) is reported for the panel.
"""
import json, sys
import pandas as pd

P = ['HardGOP', 'SoftGOP', 'Swing', 'SoftDem', 'HardDem']
K = ['party', 'habit', 'freq', 'prim']
LEVELS = [K[:i] for i in range(len(K), 0, -1)]
net = lambda s: (s['HardGOP'] + s['SoftGOP']) - (s['HardDem'] + s['SoftDem'])

def frame(cols, rows, state):
    """Query M cells as a DataFrame summed over K, for one state (rows: lists in `cols` order)."""
    df = pd.DataFrame(rows, columns=cols)
    df = df[df.st == state].drop(columns=['st'] + [c for c in ('pad',) if c in df])
    for c in df.columns:
        if c not in ('party', 'habit', 'prim'): df[c] = df[c].astype(int)
    return df.groupby(K).sum(numeric_only=True).reset_index()

def load(path, state):
    j = json.load(open(path)); cols = [x['name'] for x in j['schema']['fields']]
    assert j.get('jobComplete', True), path
    return frame(cols, [[c['v'] for c in r['f']] for r in j['rows']], state)

def hazard(T, d, S=500):
    T = T.copy(); e = 'e%d' % d; T['rem'] = T.n - T[e]; T['late'] = T.fin - T[e]; est = None
    for lv in reversed(LEVELS):
        g = T.groupby(lv)[['rem', 'late', 'n', e]].sum().reset_index()
        g['h'] = g.late / g.rem.clip(lower=1); g['r'] = g[e] / g.n.clip(lower=1)
        if est is not None:
            g = g.merge(est[lv[:-1] + ['h', 'r']].rename(columns={'h': 'hp', 'r': 'rp'}), on=lv[:-1], how='left')
            w = g.rem / (g.rem + S); g['h'] = w * g.h + (1 - w) * g.hp
            w2 = g.n / (g.n + S); g['r'] = w2 * g.r + (1 - w2) * g.rp
        est = g[lv + ['h', 'r']]
    return est

def project(T, S, d, alpha):
    X = S.merge(hazard(T, d), on=K, how='left')
    for c in ('h', 'r'): X[c] = X[c].fillna(X.groupby('party')[c].transform('mean'))
    E = X['e%d' % d]; k = ((E / X.n.clip(lower=1)) / X.r.clip(lower=1e-4)).clip(0.2, 5) ** alpha
    X['pred'] = E + (X.n - E) * (X.h * k).clip(upper=0.97)
    return X

def shares(X, col): s = X.groupby('party')[col].sum().reindex(P); return 100 * s / s.sum()

def compute(T, S, state, asof):
    """T = {'2022': cells, '2024': cells} (training years, with fin), S = 2026 cells. Returns the proj.json dict."""
    import datetime
    S = S.copy(); S['fin'] = 0
    runs = {(t, a): shares(project(T[t], S, asof, a), 'pred') for t in T for a in (0.25, 0.5, 0.75)}
    c = runs[('2022', 0.5)]; early = shares(S, 'e%d' % asof); R = pd.DataFrame(runs)
    bt = []
    for tr, te in (('2022', '2024'), ('2024', '2022')):
        X = project(T[tr], T[te], asof, 0.5); fa = net(shares(X, 'fin'))
        bt.append(dict(dir=tr[2:] + '->' + te[2:], model=round(net(shares(X, 'pred')) - fa, 1),
                       naive=round(net(shares(X, 'e%d' % asof)) - fa, 1)))
    early_prev = {t: round(net(shares(T[t], 'e%d' % asof)), 1) for t in T}
    return dict(state=state, asof=(datetime.date(2026, 11, 3) - datetime.timedelta(days=asof)).isoformat(), dbe=asof,
                early_votes=int(S['e%d' % asof].sum()),
                groups=[dict(k=p, early=round(early[p], 1), proj=round(c[p], 1), lo=round(R.loc[p].min(), 1), hi=round(R.loc[p].max(), 1)) for p in P],
                early_net=round(net(early), 1), proj_net=round(net(c), 1),
                net_lo=round(min(net(r) for r in runs.values()), 1), net_hi=round(max(net(r) for r in runs.values()), 1),
                backtest=bt, early_prev=early_prev)

def main():
    out, state, asof = sys.argv[1], sys.argv[2], int(sys.argv[3])
    T = {'2022': load(sys.argv[4], state), '2024': load(sys.argv[5], state)}
    res = compute(T, load(sys.argv[6], state), state, asof)
    json.dump(res, open(out, 'w'), separators=(',', ':'))
    print(f"{state} as of d{asof}: early {res['early_net']:+.1f} -> projected {res['proj_net']:+.1f} "
          f"({res['net_lo']:+.1f}..{res['net_hi']:+.1f}); {res['early_votes']:,} early votes")

if __name__ == '__main__':
    main()
