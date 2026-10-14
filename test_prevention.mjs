#!/usr/bin/env node
/* Prevention-track checks (report_b): labels, NCRP_I4C, WhiteBox de-dup/MAX, merchant-clean Section 4 + per-payment list.
   Loads the engine the same way verify_engine.mjs does. Run: node test_prevention.mjs */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, 'risk_desk_v4.html'), 'utf8');
let script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
script = script.slice(0, script.indexOf("$('dirBtn').addEventListener"));
const chain = new Proxy(function () {}, {
  get(_t, p) { if (p === Symbol.toPrimitive || p === 'toString' || p === 'valueOf') return () => ''; if (p === Symbol.iterator) return undefined; return chain; },
  apply() { return chain; }, set() { return true; }, construct() { return chain; }
});
const harness = String.raw`
;(function () {
  const R = { pass: 0, fail: 0, lines: [] };
  const chk = (n, c, d) => { R.lines.push((c ? 'PASS  ' : 'FAIL  ') + n + (d ? '  [' + d + ']' : '')); c ? R.pass++ : R.fail++; };
  const iso = (base, w) => { const d = new Date(base); d.setUTCDate(d.getUTCDate() - 7 * w); return d.toISOString().slice(0, 10); };
  const weeks = []; for (let i = 0; i < 8; i++) weeks.push({ section: 'WEEKLY', metric: 'WOW_DISPUTE_RATE', dim: iso('2026-07-06', 7 - i), cap: 10000000, disp: 100000, txc: 10000, dc: 20, ratio: 1 });
  // total disputed = 8 x 1,00,000 = 8,00,000 ; captured = 8 Cr
  const q2 = [...weeks,
    { section: 'TOP_SRC', metric: 'UPI_VPA', dim: 'bad@ybl', disp: 30000, dc: 3, cap: 50000, txc: 10, ratio: 60 },
    /* shared / merchant-side handle: > 50% of captured value -> never a block target */
    { section: 'TOP_SRC', metric: 'UPI_VPA', dim: 'merchant@icici', disp: 60000, dc: 9, cap: 60000000, txc: 50000, ratio: 0.1 },
    { section: 'TOP_SRC', metric: 'UPI_VPA', dim: 'shared@icici', disp: 50000, dc: 5, cap: 60000, txc: 60000, ratio: 83 }];
  const q4 = [
    { section: 'TXN', metric: 'DOT_MNRL',        dim: '5100000001§2026-01-02', cap: 50000, disp: 40000 },
    { section: 'TXN', metric: 'NCRP_I4C',        dim: '5100000002§2026-02-03', cap: 40000, disp: 30000 },
    { section: 'TXN', metric: 'PRIOR_SAME_MID',  dim: '5100000003§2026-03-04', cap: 30000, disp: 20000 },
    { section: 'TXN', metric: 'PRIOR_CROSS_MID', dim: '5100000003§2026-02-01', cap: 30000, disp: 20000 },
    { section: 'TXN', metric: 'PRIOR_CROSS_MID', dim: '5100000004§2026-03-05', cap: 25000, disp: 15000 },
    { section: 'TXN', metric: 'ML_MODEL',        dim: '5100000005§0.91',        cap: 20000, disp: 10000 },
    { section: 'TXN', metric: 'DCH',             dim: '5100000006§',            cap: 9000,  disp: 5000 },
    { section: 'TXN', metric: 'SR',              dim: '5100000007§PHONE§9876543210', cap: 8000, disp: 4000, ratio: 20 },
    { section: 'TXN', metric: 'SOME_NEW_CODE',   dim: '5100000008§x', cap: 7000, disp: 3000 },
    { section: 'MLSTAT', metric: 'ML', dim: 'SUMMARY', cap: 400, disp: 60, dc: 40 }];
  state.mid = '553614'; state.days = 180; state.mask = true;
  state.q1 = null; state.q2 = q2; state.q3 = null; state.q4 = q4;

  /* WhiteBox: 5100000005 overlaps an ML txn (must not double count); 5100000009 is WB-only and appears twice (MAX, not SUM). */
  state.whitebox = { ids: ['5100000005', '5100000009'], fetchedMid: '553614', wbTxnAmt: 0, wbDisputedAmt: 0, wbTxnCount: 0,
    rows: [{ id: '5100000005', txnAmt: 20000, dispAmt: 10000 }, { id: '5100000009', txnAmt: 12000, dispAmt: 7000 },
           { id: '5100000009', txnAmt: 12000, dispAmt: 6000 }, { id: '5100000010', txnAmt: 5000, dispAmt: 0 }] };

  const s = q4SavableStats(state.q4);
  chk('labels: PRIOR_SAME_MID/PRIOR_CROSS_MID -> Past dispute cross merchant', Q4_FEAT_LABEL.PRIOR_SAME_MID === 'Past dispute cross merchant' && Q4_FEAT_LABEL.PRIOR_CROSS_MID === 'Past dispute cross merchant');
  chk('labels: DOT_MNRL / NCRP_I4C', Q4_FEAT_LABEL.DOT_MNRL === 'Govt of India Blacklist (DoT)' && Q4_FEAT_LABEL.NCRP_I4C === 'Govt of India Blacklist (CyberCrime/I4C)');
  chk('NCRP_I4C in X feats + priority tier next to DOT + colour', Q4_X_FEATS.includes('NCRP_I4C') && Q4_TXN_PRIORITY.indexOf('NCRP_I4C') === Q4_TXN_PRIORITY.indexOf('DOT_MNRL') + 1 && !!Q4_FEAT_COLOR.NCRP_I4C);
  chk('unknown SQL code ignored (no raw code in list)', !s.list.some(x => x.t.id === '5100000008'));
  chk('txn with both past-dispute codes counted once', s.list.filter(x => x.t.id === '5100000003').length === 1);
  const b = q4ReasonBuckets(s);
  const govt = b.find(r => r.key === 'GOVT'), cross = b.find(r => r.key === 'CROSS'), ml = b.find(r => r.key === 'ML'), oth = b.find(r => r.key === 'OTHER');
  chk('GOVT bucket = DOT + I4C (2 txns, 70,000)', govt && govt.count === 2 && govt.amt === 70000, JSON.stringify(govt));
  chk('GOVT label unchanged', govt && govt.label === 'Govt of India Blacklist (CyberCrime/I4C and other partners)');
  chk('CROSS bucket = past disputes (2 txns, 35,000)', cross && cross.count === 2 && cross.amt === 35000, JSON.stringify(cross));
  chk('WhiteBox: overlap de-duplicated, MAX per txn (ML = 10,000 + 7,000; 2 txns)', ml && ml.amt === 17000 && ml.count === 2 && s.wbOverlapCount === 1, JSON.stringify(ml));
  chk('VPA rule skips shared (>50% share) handles', s.vpa.count === 1 && s.vpa.block[0].v === 'bad@ybl', s.vpa.block.map(x => x.v).join(','));
  chk('Other = DCH + LOW_SR + VPA (txn count incl. VPA disputed txns)', oth && oth.amt === 5000 + 4000 + 30000 && oth.count === 2 + 3, JSON.stringify(oth));
  chk('X = per-txn + VPA + WB-only', s.xAmt === 115000 + 30000 + 7000, 'X ' + s.xAmt);
  chk('table reconciles to tiles (amount + count)', b.reduce((a, r) => a + r.amt, 0) === s.yAmt && b.reduce((a, r) => a + r.count, 0) === s.yShownCount, b.reduce((a, r) => a + r.amt, 0) + ' vs ' + s.yAmt + '; ' + b.reduce((a, r) => a + r.count, 0) + ' vs ' + s.yShownCount);
  state.whitebox.fetchedMid = '999999';
  chk('WhiteBox from another MID ignored', q4SavableStats(state.q4).wbIncrement === 0);
  state.whitebox.fetchedMid = '553614';

  const sec = secPrevention();
  chk('S4: no precision % claims', !/95%\+|70%\+|precision\s*\d/i.test(sec));
  chk('S4: tiles named per user', sec.includes('>High Precision Blocks<') && sec.includes('>High Fraud reduction coverage Blocks<'));
  chk('S4: table 2 value columns w/ user names', /Chargeback txns preventable/.test(sec) && /Chargeback amount preventable/.test(sec) && (sec.match(/<th[ >]/g) || []).length === 3);
  chk('S4: no ROI / benchmark / internal codes', !/ROI|Benchmark|no benchmark|PRIOR_|DOT_MNRL|NCRP_I4C|ML_MODEL|§|SR\/proxy/.test(sec));
  chk('S4: eyebrow "Section 4 · Prevention"', /Section 4 · Prevention</.test(sec));

  const lst = prevTxnListHTML();
  chk('list: txn ids never masked (full id, mask on)', lst.includes('5100000001') && !lst.includes('****000001'));
  chk('list: labels only, no codes / scores / identifiers', !/PRIOR_|DOT_MNRL|NCRP_I4C|ML_MODEL|0\.91|9876543210|§|LOW_SR|DCH\b/.test(lst));
  chk('list: Past dispute cross merchant shown', lst.includes('Past dispute cross merchant'));
  chk('list: earliest past-dispute date kept (2026-02-01)', lst.includes('2026-02-01') && !lst.includes('2026-03-04'));
  chk('list: WB-only txn listed under ML label', lst.includes('5100000009') && lst.includes('RiskIntelligence ML model'));
  chk('list: VPA summary line', /on 1 High-dispute UPI ID\./.test(lst));
  chk('list: row count = per-txn + WB-only', (lst.match(/<tr>/g) || []).length - 1 === s.list.length + 1);
  const csv = prevTxnListCSV();
  chk('csv: header + rows, full txn ids', csv.split('\n').length === s.list.length + 2 && csv.includes('5100000001'));
  state.mask = false;
  chk('list: raw txn id when masking off', prevTxnListHTML().includes('5100000001'));
  state.mask = true;

  /* no-data / no-q4 */
  state.q4 = [{ section: 'TIER', metric: 'DOT_MNRL', dim: 'EVER_LISTED', disp: 0, dc: 0 }]; state.whitebox = null; state.q2 = weeks;
  chk('S4: one result line when nothing matched', /No disputed payment in this period matched a block signal/.test(secPrevention()));
  chk('list: empty when nothing matched', prevTxnListHTML() === '');
  state.q4 = null;
  chk('S4: omitted when Q4 absent', secPrevention() === '');
  /* X == 0, only Y signals: headline uses Y, no "rises to" line */
  state.q4 = [{ section: 'TXN', metric: 'DCH', dim: '1§', cap: 100, disp: 50 }]; state.q2 = weeks;
  const h0 = q4SavableHero(state.q4);
  chk('hero: X=0 -> single Y headline', !/rises to/.test(h0) && /High Fraud reduction coverage Blocks<\/span>/.test(h0));
  globalThis.__RS = R;
})();`;
const sandbox = { console, Buffer, document: chain, window: chain, setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0,
  requestAnimationFrame: () => 0, navigator: chain, location: chain };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try { vm.runInContext(script + '\n' + harness, sandbox, { filename: 'engine.js' }); }
catch (e) { console.error(e && e.stack ? e.stack : e); process.exit(1); }
const R = sandbox.__RS;
R.lines.forEach(l => console.log('  ' + l));
console.log(`  ${R.pass} passed, ${R.fail} failed`);
process.exit(R.fail ? 1 : 0);
