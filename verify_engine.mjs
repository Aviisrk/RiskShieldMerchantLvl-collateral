#!/usr/bin/env node
/**
 * v4/verify_engine.mjs — node QA harness for RiskShield Risk Desk v4.
 *
 * Loads the DOM-free numeric engine + section builders out of risk_desk_v4.html
 * (everything up to the UI event-wiring tail) inside a chainable DOM shim, then
 * runs three golden fixtures through the verdict engine and the content lint:
 *
 *   A  high-fraud   — models reference merchant 965934
 *                     (count rate ~0.108%, fraud share 68%, CC ~4.0x over-index,
 *                      a July spike of Rs 2,35,177 at 2.2% count rate)
 *   B  clean        — low, flat, balanced  -> overall LOW
 *   C  low-volume   — below Visa VAMP's settled-txn floor
 *
 * It also compiles a full report for fixture A and asserts lintIssues() == 0
 * (AC5: no "Metabase" / "paste" / "Q1-Q4" leakage in the deliverable).
 *
 * Run:  node v4/verify_engine.mjs
 * Exit: 0 = all checks passed, 1 = one or more failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, 'risk_desk_v4.html'), 'utf8');

/* ---- pull the single inline <script> block ---- */
const open = html.indexOf('<script>');
const close = html.lastIndexOf('</script>');
if (open < 0 || close < 0) { console.error('Could not find <script> block.'); process.exit(1); }
let script = html.slice(open + '<script>'.length, close);

/* Drop the UI event-wiring + bootstrap tail (everything from the first
   top-level $('...').addEventListener onward) so nothing auto-runs in node.
   Every pure declaration the engine + composeReport need sits above it. */
const cut = script.indexOf("$('dirBtn').addEventListener");
if (cut > 0) script = script.slice(0, cut);
else console.warn('warn: UI-wiring marker not found; relying on DOM shim only.');

/* ---- chainable DOM/window shim: any access returns a callable no-op ---- */
const chain = new Proxy(function () {}, {
  get(_t, p) {
    if (p === Symbol.toPrimitive || p === 'toString' || p === 'valueOf') return () => '';
    if (p === Symbol.iterator) return undefined;
    return chain;
  },
  apply() { return chain; },
  set() { return true; },
  construct() { return chain; }
});

/* ---- test harness, appended IN-SCOPE so it can see all const/function decls ---- */
const harness = String.raw`
/* ================= APPENDED QA HARNESS (in engine scope) ================= */
;(function () {
  const R = { pass: 0, fail: 0, lines: [] };
  const approx = (a, b, t) => a != null && Math.abs(a - b) <= t;
  function chk(name, cond, detail) {
    R.lines.push((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
    cond ? R.pass++ : R.fail++;
  }
  const isoMinusWeeks = (base, w) => { const d = new Date(base); d.setUTCDate(d.getUTCDate() - 7 * w); return d.toISOString().slice(0, 10); };
  const setQ = (q1, q2, q3, q4) => { state.q1 = q1; state.q2 = q2; state.q3 = q3; state.q4 = q4; };

  /* ---------- FIXTURE A: high-fraud (reference merchant 965934) ---------- */
  const A_BASE = '2026-07-06';
  const weeksA = [];
  for (let i = 0; i < 16; i++) {
    const isSpike = (i === 15);
    const dim = isoMinusWeeks(A_BASE, 15 - i);
    const txc = isSpike ? 90000 : 127000;
    const dc  = isSpike ? 1980  : 12;          // spike count-rate = 1980/90000 = 2.2%
    const cap = isSpike ? 10700000 : 30000000;
    const disp = isSpike ? 235177 : 50000;
    weeksA.push({ section: 'WEEKLY', metric: 'WOW_DISPUTE_RATE', dim, cap, disp, txc, dc, ratio: cap ? 100 * disp / cap : null });
  }
  const q2A = [
    ...weeksA,
    { section: 'DGROUP', metric: 'FRAUD',   disp: 680000, dc: 120 },
    { section: 'DGROUP', metric: 'SERVICE', disp: 220000, dc: 60 },
    { section: 'DGROUP', metric: 'PROCESS', disp: 50000,  dc: 20 },
    { section: 'DGROUP', metric: 'UNCODED', disp: 50000,  dc: 15 },
    { section: 'DSPLIT', metric: 'BY_PAYMENTMODE', dim: 'CC',  disp: 800000 },
    { section: 'DSPLIT', metric: 'BY_PAYMENTMODE', dim: 'UPI', disp: 150000 },
    { section: 'DSPLIT', metric: 'BY_PAYMENTMODE', dim: 'NB',  disp: 50000 },
    { section: 'TOP_SRC', metric: 'UPI_VPA', dim: 'a@upi',        disp: 200000, dc: 40, cap: 900000, txc: 300, ratio: 22 },
    /* one handle clears the >30% amount-ratio block gate (50k/100k = 50%); sized below e@upi so top-5 concentration is unchanged */
    { section: 'TOP_SRC', metric: 'UPI_VPA', dim: 'fraudring@paytm', disp: 50000, dc: 9, cap: 100000, txc: 60, ratio: 50 },
    { section: 'TOP_SRC', metric: 'UPI_VPA', dim: 'b@upi',        disp: 150000, dc: 30, cap: 700000, txc: 250, ratio: 21 },
    { section: 'TOP_SRC', metric: 'UPI_VPA', dim: 'c@upi',        disp: 120000, dc: 25, cap: 600000, txc: 220, ratio: 20 },
    { section: 'TOP_SRC', metric: 'UPI_VPA', dim: 'd@upi',        disp: 90000,  dc: 18, cap: 500000, txc: 180, ratio: 18 },
    { section: 'TOP_SRC', metric: 'UPI_VPA', dim: 'e@upi',        disp: 60000,  dc: 12, cap: 400000, txc: 140, ratio: 15 },
    { section: 'TOP_SRC', metric: 'UPI_VPA', dim: 'scam.1@okhdfc', disp: 40000, dc: 8, cap: 300000, txc: 90, ratio: 13 },
    { section: 'TOP_SRC', metric: 'UPI_VPA', dim: 'scam.2@okhdfc', disp: 30000, dc: 6, cap: 250000, txc: 80, ratio: 12 }
  ];
  const q1A = [
    { section: 'GMV', metric: 'TOTAL_CAPTURED', cap: 100000000, txc: 1995000 },
    { section: 'GMV', metric: 'CAPTURED_BY_PAYMENTMODE', dim: 'CC',  cap: 20000000 },
    { section: 'GMV', metric: 'CAPTURED_BY_PAYMENTMODE', dim: 'UPI', cap: 70000000 },
    { section: 'GMV', metric: 'CAPTURED_BY_PAYMENTMODE', dim: 'NB',  cap: 10000000 }
  ];
  const q3A = [
    { scope: 'OVERALL', idtype: 'UPI_VPA', idvalue: 'ring@upi',   disp: 80000, dc: 12 },
    { scope: 'OVERALL', idtype: 'EMAIL',   idvalue: 'bad@x.com',  disp: 35000, dc: 6 },
    { scope: 'PER_MERCHANT', idtype: 'UPI_VPA', idvalue: 'ring@upi',  mid: '965934', disp: 50000 },
    { scope: 'PER_MERCHANT', idtype: 'UPI_VPA', idvalue: 'ring@upi',  mid: '111111', disp: 30000 },
    { scope: 'PER_MERCHANT', idtype: 'EMAIL',   idvalue: 'bad@x.com', mid: '965934', disp: 20000 },
    { scope: 'PER_MERCHANT', idtype: 'EMAIL',   idvalue: 'bad@x.com', mid: '222222', disp: 15000 }
  ];
  /* Q4 preventable disputes — one disputed txn per hard/soft signal (amount basis).
     X (excl. SR/proxy) = DOT_MNRL 40k + CF_BLACKLIST 30k + MERCHANT_BLACKLIST 25k + PRIOR_SAME_MID 20k
                          + PRIOR_CROSS_MID 15k + ML_MODEL 35k = 165k per-txn, plus the 50k VPA fold.
     Y-only (SR/proxy)  = DCH 12k + LOW_SR 8k = 20k.  MLSTAT sample = 500 (at the reporting gate). */
  const q4A = [
    { section: 'TXN', metric: 'DOT_MNRL',           dim: 't1§ring@upi',        cap: 60000, disp: 40000 },
    { section: 'TXN', metric: 'CF_BLACKLIST',       dim: 't2§bad@x.com',       cap: 50000, disp: 30000 },
    { section: 'TXN', metric: 'MERCHANT_BLACKLIST', dim: 't3§scam@upi',        cap: 40000, disp: 25000 },
    { section: 'TXN', metric: 'PRIOR_SAME_MID',     dim: 't4§9990001',         cap: 30000, disp: 20000 },
    { section: 'TXN', metric: 'PRIOR_CROSS_MID',    dim: 't5§8880002',         cap: 25000, disp: 15000 },
    { section: 'TXN', metric: 'ML_MODEL',           dim: 't6§0.87',            cap: 45000, disp: 35000 },
    { section: 'TXN', metric: 'DCH',                dim: 't7§',                cap: 18000, disp: 12000 },
    { section: 'TXN', metric: 'SR',                 dim: 't8§UPI_VPA§low@upi', cap: 12000, disp: 8000, ratio: 35 },
    { section: 'MLSTAT', metric: 'ML', dim: 'SUMMARY', cap: 400, disp: 60, dc: 40 }
  ];

  state.mid = '965934'; state.days = 180; state.mask = false;
  setQ(q1A, q2A, q3A, q4A);

  const drA = disputeRates();
  chk('A.disputeRates.hasData', drA.hasData === true);
  chk('A.countRate ~0.108%', approx(drA.countRate, 0.1083, 0.003), 'got ' + drA.countRate);
  chk('A.capturedTxns == 1,995,000', drA.capturedTxns === 1995000, 'got ' + drA.capturedTxns);

  const scr = sigDisputeRate();
  chk('A.amount-rate signal (primary) grade LOW', scr.grade.g === 'LOW', 'score ' + Math.round(scr.score) + ' grade ' + scr.grade.g);

  const rgA = reasonGroups();
  chk('A.fraudShare == 68%', approx(rgA.fraudShare, 68, 0.01), 'got ' + rgA.fraudShare);
  chk('A.fraud-signal grade HIGH', sigFraudShare().grade.g === 'HIGH', 'grade ' + sigFraudShare().grade.g);

  const spA = spikes();
  chk('A.exactly 1 spike week', spA.list.length === 1, 'got ' + spA.list.length);
  const wA = spA.list[0] || {};
  chk('A.spike disputed == Rs 2,35,177', wA.disp === 235177, 'got ' + wA.disp);
  chk('A.spike count-rate == 2.2%', approx(wA.rate, 2.2, 0.001), 'got ' + wA.rate);

  const oiA = overIndex();
  chk('A.over-index worst mode = CC', oiA.hasData && oiA.rows[0] && oiA.rows[0].mode === 'CC', 'top ' + (oiA.rows[0] && oiA.rows[0].mode));
  chk('A.CC over-index ~4.0x', oiA.rows[0] && approx(oiA.rows[0].index, 4.0, 0.02), 'got ' + (oiA.rows[0] && oiA.rows[0].index));

  const clA = clusters();
  chk('A.VPA family collapses scam.1/scam.2', clA.families.some(f => f.key === 'scam@okhdfc' && f.n === 2), 'families ' + clA.families.map(f => f.key).join(','));
  chk('A.cross-merchant identifiers == 2', clA.networked.length === 2, 'got ' + clA.networked.length);

  const vA = verdict();
  chk('A.verdict coverage 5/5', vA.coverage === 5, 'got ' + vA.coverage);
  chk('A.overall score ~52.6', approx(vA.overallScore, 52.6, 1.2), 'got ' + (vA.overallScore && vA.overallScore.toFixed(2)));
  chk('A.overall grade ELEVATED', vA.grade.g === 'ELEVATED', 'grade ' + vA.grade.g);
  const rtA = reconText(vA);
  chk('A.recon mentions trend + fraud', /trend/i.test(rtA) && /fraud/i.test(rtA));
  chk('A.recon states overall grade', /ELEVATED/.test(rtA));

  const actsA = reportActions();
  chk('A.actions produced (<=5)', actsA.length >= 1 && actsA.length <= 5, 'got ' + actsA.length);
  chk('A.top action is CRITICAL fraud', actsA[0] && actsA[0].sev === 'CRITICAL', actsA[0] && actsA[0].title);

  /* ---- preventable disputes (Section 4, amount basis): X/Y buckets + VPA fold + attribution reconciliation ---- */
  const savA = q4SavableStats(state.q4);
  chk('A.q4 preventable hasData', savA.hasData === true);
  chk('A.per-txn X (excl. VPA) == Rs 1,65,000', savA.perTxnXAmt === 165000, 'got ' + savA.perTxnXAmt);
  chk('A.one signal per disputed txn: 8 rows (6 X + 2 Y-only)',
      savA.list.length === 8 && savA.xTxnCount === 6 && savA.yOnlyTxnCount === 2,
      'list ' + savA.list.length + ' X ' + savA.xTxnCount + ' Yonly ' + savA.yOnlyTxnCount);
  chk('A.VPA blocks only >30% handles (1 of 8)',
      savA.vpa.count === 1 && savA.vpa.block[0].ratio > 30 && savA.vpa.block[0].v === 'fraudring@paytm',
      'count ' + savA.vpa.count + ' top ' + (savA.vpa.block[0] && savA.vpa.block[0].v));
  chk('A.VPA fold into X == Rs 50,000', savA.vpaIncrement === 50000 && savA.vpaSeg && savA.vpaSeg.amt === 50000, 'got ' + savA.vpaIncrement);
  chk('A.X = per-txn hard + VPA == Rs 2,15,000', savA.xAmt === 215000 && approx(savA.xAmt, savA.perTxnXAmt + savA.vpaIncrement, 1), 'got ' + savA.xAmt);
  chk('A.Y = X + SR/proxy == Rs 2,35,000', savA.yAmt === 235000 && savA.yExtra === 20000, 'got ' + savA.yAmt);
  chk('A.X subset of Y (X <= Y)', savA.xAmt <= savA.yAmt);
  chk('A.X% and Y% both <= 100%', savA.xPct <= 100 && savA.yPct <= 100, 'X ' + savA.xPct.toFixed(1) + '% Y ' + savA.yPct.toFixed(1) + '%');
  chk('A.X% ~21.8% of disputed value', approx(savA.xPct, 21.82, 0.1), 'got ' + savA.xPct.toFixed(2));
  chk('A.Y% ~23.9% of disputed value', approx(savA.yPct, 23.85, 0.1), 'got ' + savA.yPct.toFixed(2));
  const xSegSumA = savA.xSegments.reduce((a, s) => a + s.amt, 0) + (savA.vpaSeg ? savA.vpaSeg.amt : 0);
  const ySegSumA = savA.ySegments.reduce((a, s) => a + s.amt, 0);
  chk('A.attribution reconciles (rows -> X subtotal -> Y total)',
      approx(xSegSumA, savA.xAmt, 1) && approx(savA.xAmt + ySegSumA, savA.yAmt, 1),
      'xseg ' + xSegSumA + ' vs X ' + savA.xAmt + '; +yseg ' + ySegSumA + ' vs Y ' + savA.yAmt);

  /* full report + content lint (AC5) */
  const rep = composeReport();
  chk('A.composeReport returns HTML', typeof rep === 'string' && rep.length > 4000, 'len ' + (rep && rep.length));
  chk('A.report headline present', /Risk, decided/.test(rep) && rep.includes('965934'));
  const li = lintIssues(rep);
  chk('A.lint clean (0 blocklisted terms)', li.length === 0, li.map(x => x.term + 'x' + x.count).join(' | '));

  /* render-QA: no formatting artifacts leaked into the deliverable */
  chk('A.no NaN in report', !/\bNaN\b/.test(rep));
  chk('A.no undefined in report', !/\bundefined\b/.test(rep));
  chk('A.no [object Object]', !/\[object Object\]/.test(rep));
  chk('A.no null cells', !/>null</.test(rep));
  chk('A.all 4 body sections present', ['Section 1', 'Section 2', 'Section 3', 'Section 4'].every(s => rep.includes(s)),
      ['Section 1','Section 2','Section 3','Section 4'].filter(s => !rep.includes(s)).join(',') || 'ok');
  /* merchant build: Appendix B (methodology) and D (data QA) are internal-only (user decision) */
  chk('A.merchant appendices A + C present, B/D absent', /id="appxA"/.test(rep) && /id="appxC"/.test(rep) && !/id="appx[BD]"/.test(rep));
  chk('A.embeds downloadable CSV', /href="data:text\/csv/.test(rep));

  /* print-handler subsets (validates the two fixed button handlers) */
  /* appendix *sections* carry id="appxA..D"; body prose may still cross-reference "Appendix A" */
  const hasAppxSections = h => /id="appx[ABCD]"/.test(h);
  const prev = composeReport({ only: ['prevention'], appendices: false });
  chk('prevention subset: Section 4 only', prev.includes('Section 4') && !prev.includes('Section 1') && !prev.includes('Section 2'), 'prevention subset');
  chk('prevention subset: no appendix sections', !hasAppxSections(prev));
  const exec = composeReport({ appendices: false });
  chk('exec-pack: all 4 body sections', ['Section 1','Section 2','Section 3','Section 4'].every(s => exec.includes(s)));
  chk('exec-pack: no appendix sections', !hasAppxSections(exec));
  chk('full report: has appendix sections', hasAppxSections(rep));

  /* ---------- FIXTURE B: clean ---------- */
  const weeksB = [];
  for (let i = 0; i < 16; i++) weeksB.push({ section: 'WEEKLY', metric: 'WOW_DISPUTE_RATE',
    dim: isoMinusWeeks('2026-07-06', 15 - i), cap: 25000000, disp: 8000, txc: 100000, dc: 10, ratio: 0.032 });
  const q2B = [
    ...weeksB,
    { section: 'DGROUP', metric: 'FRAUD',   disp: 10000,  dc: 3 },
    { section: 'DGROUP', metric: 'SERVICE', disp: 180000, dc: 40 },
    { section: 'DGROUP', metric: 'PROCESS', disp: 10000,  dc: 5 },
    { section: 'DSPLIT', metric: 'BY_PAYMENTMODE', dim: 'CC',  disp: 60000 },
    { section: 'DSPLIT', metric: 'BY_PAYMENTMODE', dim: 'UPI', disp: 100000 },
    { section: 'DSPLIT', metric: 'BY_PAYMENTMODE', dim: 'NB',  disp: 40000 },
    { section: 'TOP_SRC', metric: 'UPI_VPA', dim: 'p@upi', disp: 15000, dc: 3, cap: 400000, txc: 120, ratio: 4 },
    { section: 'TOP_SRC', metric: 'UPI_VPA', dim: 'q@upi', disp: 10000, dc: 2, cap: 300000, txc: 100, ratio: 3 },
    { section: 'TOP_SRC', metric: 'UPI_VPA', dim: 'r@upi', disp: 8000,  dc: 2, cap: 250000, txc: 90,  ratio: 3 }
  ];
  const q1B = [
    { section: 'GMV', metric: 'TOTAL_CAPTURED', cap: 100000000, txc: 1600000 },
    { section: 'GMV', metric: 'CAPTURED_BY_PAYMENTMODE', dim: 'CC',  cap: 30000000 },
    { section: 'GMV', metric: 'CAPTURED_BY_PAYMENTMODE', dim: 'UPI', cap: 50000000 },
    { section: 'GMV', metric: 'CAPTURED_BY_PAYMENTMODE', dim: 'NB',  cap: 20000000 }
  ];
  state.mid = 'CLEAN001'; state.days = 180; state.mask = false;
  setQ(q1B, q2B, null, null);
  const drB = disputeRates(), vB = verdict();
  chk('B.countRate ~0.01%', approx(drB.countRate, 0.01, 0.001), 'got ' + drB.countRate);
  chk('B.amount-rate signal grade LOW', sigDisputeRate().grade.g === 'LOW');
  chk('B.fraud-signal grade LOW', sigFraudShare().grade.g === 'LOW', 'share ' + reasonGroups().fraudShare);
  chk('B.no spikes', spikes().list.length === 0);
  chk('B.over-index max ~1.0x', approx(overIndex().rows[0].index, 1.0, 0.001), 'got ' + overIndex().rows[0].index);
  chk('B.overall grade LOW', vB.grade.g === 'LOW', 'score ' + (vB.overallScore && vB.overallScore.toFixed(2)) + ' grade ' + vB.grade.g);
  chk('B.lint clean', lintIssues(composeReport()).length === 0);

  /* ---------- FIXTURE C: low-volume (below VAMP floor) ---------- */
  const weeksC = [];
  for (let i = 0; i < 3; i++) weeksC.push({ section: 'WEEKLY', metric: 'WOW_DISPUTE_RATE',
    dim: isoMinusWeeks('2026-07-06', 2 - i), cap: 50000, disp: 6000, txc: 150, dc: 1, ratio: 12 });
  state.mid = 'LOWVOL01'; state.days = 180; state.mask = false;
  setQ(null, weeksC, null, null);
  const drC = disputeRates(), scrC = sigDisputeRate(), vC = verdict();
  chk('C.capturedTxns == 450 (< 1500 floor)', drC.capturedTxns === 450 && drC.capturedTxns < 1500, 'got ' + drC.capturedTxns);
  /* VAMP floor text was removed from merchant copy; the flag is kept for the internal build */
  chk('C.dispute-rate signal flags VAMP floor (belowFloor)', scrC.belowFloor === true, scrC.note);
  chk('C.no spikes (thin history)', spikes().list.length === 0);
  chk('C.fraud signal N/A (no reason codes)', sigFraudShare().grade.g === 'N/A');
  chk('C.verdict still computes', vC.grade && typeof vC.grade.g === 'string', 'grade ' + (vC.grade && vC.grade.g) + ' coverage ' + vC.coverage);
  chk('C.lint clean', lintIssues(composeReport()).length === 0);

  /* ---------- FIXTURE M: merchant-report guards (553614-shaped: server IP, 0-dispute PER_MERCHANT rows, MHA, raw grids) ---------- */
  const wM = [];
  for (let i = 0; i < 8; i++) wM.push({ section: 'WEEKLY', metric: 'W', dim: isoMinusWeeks('2026-07-06', 7 - i), cap: 100000000, disp: 3000000, txc: 20000, dc: 250, ratio: 3 });
  state.mid = '553614'; state.days = 180; state.mask = true;
  setQ([{ section: 'IDENTIFIERS', metric: 'DUMMY_EMAIL', dim: 'test@merchant.in', txc: 900 }],
    [...wM, { section: 'SUMMARY', metric: 'MHA_INCLUDED', txc: 20, disp: 400000 },
      { section: 'DGROUP', metric: 'FRAUD', disp: 18000000, dc: 1500 }, { section: 'DGROUP', metric: 'UNMAPPED', disp: 6000000, dc: 500 },
      { section: 'DSPLIT', metric: 'BY_REASON', dim: '1401', disp: 18000000, dc: 1500 }, { section: 'DSPLIT', metric: 'BY_REASON', dim: '1142', disp: 2000000, dc: 260 },
      { section: 'TOP_SRC', metric: 'IP_NON_DCH', dim: '35.200.133.171', cap: 770000000, txc: 155000, disp: 23800000, dc: 1950 },
      { section: 'TOP_SRC', metric: 'IP_NON_DCH', dim: '34.93.94.12', cap: 900000, txc: 40, disp: 84788, dc: 14 },
      { section: 'TOP_SRC', metric: 'CARD_PAR', dim: 'abcd1234ef§V001', cap: 50000, txc: 4, disp: 90000, dc: 3 },
      { section: 'TOP_SRC', metric: 'CARD_BIN', dim: '512345', cap: 9000000, txc: 900, disp: 300000, dc: 30 },
      { section: 'NOTE', metric: 'PINCODE_RATIO', dim: 'Not derivable: no pincode column' }],
    [{ scope: 'PER_MERCHANT', idtype: 'EMAIL', idvalue: 'x@gmail.com', mid: '777002', disp: 0, dc: 0 },
     { scope: 'PER_MERCHANT', idtype: 'EMAIL', idvalue: 'x@gmail.com', mid: '777003', disp: 0, dc: 0 },
     { scope: 'PER_MERCHANT', idtype: 'PHONE', idvalue: '9876543210', mid: '553614', disp: 20000, dc: 1 }], null);
  const drM = disputeRates(), cM = sigConcentration(), repM = composeReport();
  chk('M.MHA-matched payments excluded from dispute rate', drM.disputedAmt === 24000000 - 400000 && drM.disputes === 2000 - 20, drM.disputedAmt + ' / ' + drM.disputes);
  chk('M.server IP (>50% share) never shown', topSources({ withBin: true }).every(r => r.dim !== '35.200.133.171') && !/35\.200\.133/.test(repM));
  chk('M.concentration per type, <= 100%', /in top 5/.test(cM.value) && parseFloat(cM.value) <= 100, cM.value);
  chk('M.clusters: 0-dispute / own-MID rows not networked', clusters().networked.length === 0);
  chk('M.fraud code 1142 folded into Fraud (MHA out of Other)', approx(reasonGroups().fraudShare, 100 * 20000000 / 23600000, 0.01), 'share ' + reasonGroups().fraudShare);
  chk('M.no raw grids / other MIDs / internal text', !/777002|Not derivable|DUMMY_EMAIL|IP_NON_DCH|TOP_SRC|VAMP|§|Q[1-4]\b|weights|Appendix D/.test(repM.replace(/data:[^"]*/g, '')));
  chk('M.lint enforced at compose (0 left)', composeReport.lastLint && composeReport.lastLint.left.length === 0 && lintIssues(repM).length === 0);
  chk('M.lint cleans internal terms', !lintIssues(lintClean('VAMP (§5.3) via Q2 and PRIOR_SAME_MID, SR/proxy, DCH')).length);

  /* ---------- empty-state / suppression (5.9) ---------- */
  state.mid = 'EMPTY001'; setQ(null, null, null, null);
  chk('D.empty parse -> composeReport null', composeReport() === null);

  /* ---------- exercise the in-app browser self-test too ---------- */
  const _log = console.log; console.log = () => {};
  let st = null; try { st = __riskShieldSelfTest(); } catch (e) { st = { fail: 1, err: String(e) }; }
  console.log = _log;
  chk('in-app __riskShieldSelfTest() all pass', st && st.fail === 0, st ? (st.pass + ' pass / ' + st.fail + ' fail') : (st && st.err));

  globalThis.__RS = R;
})();
`;

/* ---- run everything in a fresh context with the shim ---- */
const sandbox = { console, Buffer, document: chain, window: chain,
  setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0,
  requestAnimationFrame: () => 0, navigator: chain, location: chain };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try {
  vm.runInContext(script + '\n' + harness, sandbox, { filename: 'risk_desk_v4.engine.js' });
} catch (e) {
  console.error('\nENGINE LOAD/RUN ERROR:\n', e && e.stack ? e.stack : e);
  process.exit(1);
}

const R = sandbox.__RS;
if (!R) { console.error('Harness did not report results.'); process.exit(1); }
console.log('\nRiskShield v4 — engine verification\n' + '='.repeat(52));
R.lines.forEach(l => console.log('  ' + l));
console.log('='.repeat(52));
console.log('  ' + R.pass + ' passed, ' + R.fail + ' failed\n');
process.exit(R.fail ? 1 : 0);
