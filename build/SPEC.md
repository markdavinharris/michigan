# Michigan early-vote data extraction spec

Use the MCP tool `mcp__Google_Cloud_BigQuery__execute_sql_readonly` with projectId `coldspark-voterdata`,
timeoutMs 180000. Results are capped at 3,000 rows: if a query returns exactly 3000 rows, split its
county range further and re-run. Write output files with the Write tool as compact JSON (no pretty
printing) into /tmp/claude-0/-home-claude/49552102-ea01-5ec6-a096-5cdbc5f3e101/scratchpad/michigan/data/ .
Transcribe numbers exactly; after writing, re-read the file and spot-check 3 rows against the query output.

## Year parameters

| year | abev table | voter file table | Election Day |
|---|---|---|---|
| 2026 | `coldspark-voterdata.national_file.abev_2026` | `coldspark-voterdata.national_file.voters` | 2026-11-03 |
| 2024 | `coldspark-voterdata.national_file.abev_2024` | `coldspark-voterdata.national_file.voterfile_2024` | 2024-11-05 |
| 2022 | `coldspark-voterdata.national_file.abev_2022` | `coldspark-voterdata.national_file.voterfile_2022` | 2022-11-08 |

## Party note
The party CASE accepts both registered and modeled labels, so the same SQL works in registration states (OH, IA) and
modeled-party states (MI, TX: `Modeled Republican` / `Modeled Democrat` / `Modeled Independent/Unaffiliated`).

## Common CTE (substitute ABEV, VF, ED, YEAR)

```sql
WITH a AS (
  SELECT
    IFNULL(UPPER(v.CountyName), 'UNKNOWN') AS county,  -- Michigan ABEV Jurisname is the city/township, so county comes from the voter file
    a.RequestDate, a.ReturnDate, a.EarlyVoted, a.Rejected,
    CASE WHEN v.PartyRollUp IN ('Republican','Modeled Republican') THEN 'R' WHEN v.PartyRollUp IN ('Democrat','Modeled Democrat') THEN 'D' ELSE 'O' END AS party
  FROM `ABEV` a
  LEFT JOIN `VF` v ON v.DT_Regid = a.DT_Regid AND v.State = 'MI'
  WHERE a.State = 'MI'
),
u AS (
  SELECT county, 'req' AS m, DATE_DIFF(DATE 'ED', RequestDate, DAY) AS d, party FROM a
    WHERE Rejected = 0 AND RequestDate BETWEEN DATE 'YEAR-01-01' AND DATE 'YEAR-12-31'
  UNION ALL
  SELECT county, 'ret', DATE_DIFF(DATE 'ED', ReturnDate, DAY), party FROM a
    WHERE Rejected = 0 AND ReturnDate BETWEEN DATE 'YEAR-01-01' AND DATE 'YEAR-12-31'
  UNION ALL
  SELECT county, 'eip', DATE_DIFF(DATE 'ED', EarlyVoted, DAY), party FROM a
    WHERE EarlyVoted BETWEEN DATE 'YEAR-01-01' AND DATE 'YEAR-12-31'
)
```

## Query S — statewide daily (one per year)

```sql
<CTE>
SELECT d,
  COUNTIF(m='req' AND party='R') reqR, COUNTIF(m='req' AND party='D') reqD, COUNTIF(m='req' AND party='O') reqO,
  COUNTIF(m='ret' AND party='R') retR, COUNTIF(m='ret' AND party='D') retD, COUNTIF(m='ret' AND party='O') retO,
  COUNTIF(m='eip' AND party='R') eipR, COUNTIF(m='eip' AND party='D') eipD, COUNTIF(m='eip' AND party='O') eipO
FROM u WHERE d BETWEEN -14 AND 60 GROUP BY d ORDER BY d
```
Add `REPEAT('x',10000) pad` as a last column so the result is saved to a file (Query S is small enough to come back inline otherwise). Also, per year, run a totals query on the CTE `a`:
```sql
<CTE a only>
SELECT COUNT(*) rows_total, COUNTIF(Rejected=1) rejected, COUNTIF(party='O' AND <unmatched>) ...
```
Simplest: `SELECT COUNT(*) rows_total, COUNTIF(Rejected=1) rejected_rows, COUNTIF(v.DT_Regid IS NULL) unmatched_rows FROM ABEV a LEFT JOIN VF v ON ... WHERE a.State='MI'`.

Output `daily.json`:
```json
{"2026":{"rows":[[d,reqR,reqD,reqO,retR,retD,retO,eipR,eipD,eipO],...],"rows_total":N,"rejected_rows":N,"unmatched_rows":N},
 "2024":{...},"2022":{...}}
```

## Query C — county daily (one per year, chunked by county range)

```sql
<CTE>
SELECT county, d, <same 9 COUNTIF columns as Query S>
FROM u WHERE d BETWEEN -14 AND 60 AND county >= 'I' AND county < 'M'   -- chunk
GROUP BY county, d ORDER BY county, d
```
Michigan requests start at the 60-day cutoff, so each county has up to ~75 day rows: chunk every year by county, `< 'I'`, `>= 'I' AND < 'M'`, `>= 'M' AND < 'O'`, `>= 'O'` (UNKNOWN falls in the last chunk). Add `REPEAT('x',300) pad` and run `merge_county.py out.json chunk1 chunk2 chunk3 chunk4` on the saved results (it drops `pad` and maps ST. CLAIR / ST. JOSEPH to the voter-file spelling).

Output `county_daily_YEAR.json`: `{"COUNTY":[[d,reqR,...,eipO],...], ...}` (83 counties plus UNKNOWN for rows that matched no voter; build.py drops UNKNOWN).

## Query P — precinct level, 2026 only (chunked by county range)
Michigan has about 3,900 precinct codes: two chunks, `UPPER(CountyName) < 'O'` and `>= 'O'` (WAYNE alone is 719 rows, OAKLAND 405); split further if any returns 3000 rows. `merge_precinct.py out.json chunk1 chunk2` converts the saved results.

```sql
SELECT UPPER(v.CountyName) county, v.PrecinctCode precinct,
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
  SELECT DT_Regid, CountyName, PrecinctCode,
    CASE WHEN PartyRollUp IN ('Republican','Modeled Republican') THEN 'R' WHEN PartyRollUp IN ('Democrat','Modeled Democrat') THEN 'D' ELSE 'O' END AS party
  FROM `coldspark-voterdata.national_file.voters`
  WHERE State='MI' AND UPPER(CountyName) < 'M'   -- chunk
) v
LEFT JOIN `coldspark-voterdata.national_file.abev_2026` a ON a.DT_Regid = v.DT_Regid AND a.State='MI'
GROUP BY 1,2 ORDER BY 1,2
```

Output `precinct_2026.json`: `{"COUNTY":[["precinctCode",regR,regD,regO,reqR,reqD,reqO,retR,retD,retO,eipR,eipD,eipO],...],...}`.
Precinct code may be NULL → use "" .

## Query H — party × vote history cells (2026 and 2022; one query per year, 83 × 3 × 5 = 1,245 rows; `heat_merge.py out.json result`)

Run AFTER daily.json exists: replace `ASOF` below with the as-of day `build.py` reports (smallest d with
returns + in-person > 500; 15 on 2026-10-19). Both years use that same ASOF so the cells compare the same point.
Add the `pad` column so the result is saved to a file instead of returned inline.

2026 (current file; history = generals 2018–2024):
```sql
SELECT UPPER(v.CountyName) county,
  CASE WHEN v.PartyRollUp IN ('Republican','Modeled Republican') THEN 'R' WHEN v.PartyRollUp IN ('Democrat','Modeled Democrat') THEN 'D' ELSE 'O' END party,
  (IF(v.VH18G IS NOT NULL,1,0)+IF(v.VH20G IS NOT NULL,1,0)+IF(v.VH22G IS NOT NULL,1,0)+IF(v.VH24G IS NOT NULL,1,0)) hist,
  COUNT(*) reg,
  COUNTIF((a.Rejected=0 AND a.ReturnDate BETWEEN DATE '2026-01-01' AND DATE_SUB(DATE '2026-11-03', INTERVAL ASOF DAY)) OR a.EarlyVoted BETWEEN DATE '2026-01-01' AND DATE_SUB(DATE '2026-11-03', INTERVAL ASOF DAY)) ev_now,
  COUNTIF(a.Rejected=0 AND a.ReturnDate BETWEEN DATE '2026-01-01' AND DATE_SUB(DATE '2026-11-03', INTERVAL ASOF DAY)) mail_now,
  COUNTIF(a.EarlyVoted BETWEEN DATE '2026-01-01' AND DATE_SUB(DATE '2026-11-03', INTERVAL ASOF DAY)) eip_now,
  COUNTIF(a.Rejected=0 AND a.RequestDate BETWEEN DATE '2026-01-01' AND DATE_SUB(DATE '2026-11-03', INTERVAL ASOF DAY)) req_now,
  REPEAT('x',300) pad
FROM `coldspark-voterdata.national_file.voters` v
LEFT JOIN `coldspark-voterdata.national_file.abev_2026` a ON a.DT_Regid = v.DT_Regid AND a.State='MI'
WHERE v.State='MI' GROUP BY 1,2,3 ORDER BY 1,2,3
```
2022 (voterfile_2022 + abev_2022; history = generals 2014–2020; Election Day 2022-11-08): same query with the
tables and dates swapped, `VH14G/VH16G/VH18G/VH20G` for `hist`, and two extra columns before `pad`:
`COUNTIF((a.Rejected=0 AND a.ReturnDate BETWEEN DATE '2022-01-01' AND DATE '2022-12-31') OR a.EarlyVoted BETWEEN DATE '2022-01-01' AND DATE '2022-12-31') ev_final, COUNTIF(v.VH22G IS NOT NULL) voted22`.

Output `heat_2026.json` / `heat_2022.json` (the `heat_merge.py` helper in the kit writes this from the saved result):
`{"cols":["hist","reg","ev_now","mail_now","eip_now","req_now"(,"ev_final","voted22")],"data":{"COUNTY":{"R":[[hist,reg,ev_now,...],...],"D":[...],"O":[...]},...}}`
