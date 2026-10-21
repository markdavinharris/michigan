import json, sys
# usage: heat_merge.py out.json result1.json [result2.json ...]  -> {"cols":[...],"data":{"COUNTY":{"R":[[hist,reg,ev_now,mail_now,eip_now,req_now(,ev_final,voted22)],...],...}}}
ALIAS = {'ST. CLAIR': 'ST CLAIR', 'ST. JOSEPH': 'ST JOSEPH'}  # Texas county spelling variants -> Census NAME.upper()
out={}; cols=None
for p in sys.argv[2:]:
    d=json.load(open(p)); assert d['jobComplete']; c=[f['name'] for f in d['schema']['fields']]; assert c[-1]=='pad'
    assert cols is None or cols==c; cols=c; assert len(d['rows'])<3000, (p, len(d['rows']))
    for r in d['rows']:
        v=[f['v'] for f in r['f']][:-1]; cty=ALIAS.get(v[0], v[0]); p_=v[1]
        out.setdefault(cty,{}).setdefault(p_,[]).append([int(x) for x in v[2:]])
    print(p[-12:], len(d['rows']))
json.dump({'cols':cols[2:-1],'data':out}, open(sys.argv[1],'w'), separators=(',',':'))
tot=[0]*len(cols[3:-1])
for c in out.values():
    for p in c.values():
        for row in p:
            for i,x in enumerate(row[1:]): tot[i]+=x
print(sys.argv[1], 'counties', len(out), 'cols', cols[2:-1], 'totals', tot)
