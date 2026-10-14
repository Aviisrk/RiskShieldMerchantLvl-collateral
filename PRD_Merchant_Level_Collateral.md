# PRD: Merchant Level Collateral

**Owner:** Risk Ops · **Audience:** Product, Sales, Risk, Engineering · **Date:** 2026-10-12

## 1. What it is
Merchant Level Collateral is a report generated for one merchant ID over a chosen look-back (e.g. 180 days). It replays the merchant's own transactions and disputes and shows, in rupees and transaction counts, how many chargebacks RiskShield would have stopped, and why.

It is built from the merchant's live data in a single run (about 8–13 minutes for a 375k-transaction merchant). Every figure traces to named transaction IDs the merchant can check against their own records.

## 2. Why it exists
**Fraud-prevention value is hard to prove in a trial.**
- A chargeback arrives weeks to months after the payment. A 10-day trial ends before most of its disputes exist, so the trial shows little or no measurable benefit.
- Vendor claims are portfolio averages ("reduces fraud by X%"), not the merchant's own numbers. Risk and finance teams cannot approve spend against a claim they cannot test.
- With no measured benefit, the enterprise's default answer is "not now". The vagueness is the blocker, not the price.

**The fix:** prove impact on history that has already matured. 180 days of the merchant's own payments already contain the disputes that a 10-day trial never will.

## 3. Perceived value
| For | Value |
|---|---|
| Merchant | A rupee figure from their own data: disputed value that would have been blocked, split by reason. No wait for a pilot to mature. |
| Merchant risk / finance | Checkable evidence: the full list of preventable transaction IDs, matched to their own dispute records. |
| Cashfree sales and account teams | A concrete, merchant-specific proof point that replaces the trial and shortens the approval cycle. |

**Principles**
- Every number is derived from the merchant's own transactions. No benchmark, no extrapolation.
- Only measured claims. Anything not measured is not shown.
- Written for the merchant: no internal terms, no other merchants' IDs, no raw system codes.

## 4. Users
- **Reader:** the merchant (risk, finance, leadership).
- **Operator:** Risk or account team member who runs, reviews and sends the report.

## 5. How impact is established
1. The merchant's transactions and disputes for the look-back period are pulled live.
2. Each disputed transaction is tested against the prevention signals, in two tiers:
   - **High Precision Blocks:** disputed value that deterministic signals (government and cross-merchant blacklists, repeat-offender links, ML models) plus the WhiteBox rule backtest would have blocked.
   - **High Fraud reduction coverage Blocks:** High Precision plus lower-confidence signals (low success-rate customer, data-centre IP).
3. Each disputed transaction counts once, even if several signals fire. A transaction flagged by a lower-tier signal that WhiteBox also blocks counts as High Precision.
4. The blocked list is exported as distinct transaction IDs with source (RiskDesk, WhiteBox, or both), so the merchant can verify each one.

## 6. Report content
| Section | Content |
|---|---|
| 1 Verdict | Dispute rate (amount and count), grade, weekly trend, spikes |
| 2 Drivers | Dispute mix by payment mode, type, reason; reason groups; outcomes |
| 3 Attack | Top dispute sources (cards, UPI IDs, IPs); customers disputing across merchants (counts only); proxy exposure (shown only when screening coverage ≥ 50%) |
| 4 Prevention | The two tiles above and a Reason of Blocks table |
| Appendix A | Clean tables and the per-payment preventable list with full transaction IDs |
| Appendix C | Glossary |

**Reason of Blocks** (fixed taxonomy; columns: Chargeback txns preventable, Chargeback amount preventable): Govt of India Blacklist (CyberCrime/I4C and other partners) · Cashfree's cross-merchant high fraud indicators · RiskIntelligence ML Models · Other fraud indicators.

**Past dispute:** any earlier dispute on the same or another merchant is labelled "Past dispute cross merchant".

## 7. Functional requirements
**Run**
- FR1 One "Run all". Units are dispatched from a single queue, at most 6 in flight.
- FR2 Newest date slices run first, so a partial run covers a contiguous recent period.
- FR3 A failed unit is retried, split smaller, then marked missing. The run never aborts. Session expiry pauses it and keeps finished units.
- FR4 Stop keeps all finished data. A re-run fetches only missing units.

**Partial export**
- FR5 Save, Print and Export build the report from whatever has finished, at any moment, with that data present.
- FR6 One line states what is partial. The verdict is marked Provisional when dispute detail is incomplete.

**WhiteBox input**
- FR7 The operator pastes backtested WhiteBox transaction IDs (one per line). They are matched to the merchant's transactions and disputes.
- FR8 The system holds every transaction it would block (its own signals plus WhiteBox), de-duplicated by transaction ID, and exports the distinct list as CSV.

**Data rules**
- FR9 Dummy identifier: an identifier is dummy if, in any one calendar month, it appears on more than 1,000 transactions **and** more than 10% of the merchant's transactions. Applied to phone, email, VPA and card (PAR), at the source merchant and across the network. The global dummy table and the merchant's own contact details are also excluded.
- FR10 Customer phone and email come from the order. Only when that value is dummy does the system fall back to transaction metadata (COD, CRED phone). A dummy email has no fallback and is excluded.
- FR11 Card identity (PAR/BIN) comes from screening results, else transaction metadata.
- FR12 Past-dispute look-back is 365 days before each transaction.
- FR13 Merchant-owned server IPs are not customer identifiers (≥100 distinct phones, or ≥10% of attempts with ≥1,000 attempts, or a private address).
- FR14 Transaction IDs are never masked or hashed in any report or export. Phones, emails, cards and IPs stay masked.
- FR15 Government blacklist signal = DoT disconnected numbers plus NCRP/I4C reported numbers, reported before the transaction.

**Non-goals:** live blocking decisions, rule authoring, per-merchant threshold tuning.

## 8. How it is optimised
Warehouse: Redshift, queried through Metabase. The design goal is a complete report in under 10 minutes for the largest merchants, and a usable report at any minute before that.

**8.1 Correctness of results**
- Metabase caps a result at 2,000 rows by default. The launcher sets an explicit row ceiling and fails loudly if any result is still truncated, so no result can be silently incomplete.

**8.2 Cut the work per query**
| Technique | Design | Measured effect |
|---|---|---|
| Single-pass scans | Redshift re-scans a CTE once per reference. Each large table is scanned once, using conditional aggregation and grouping sets | Identifier query 41s vs 364s for the multi-reference form, identical output |
| Bigint key joins | Disputes join transactions on `cftxnid = id` (sort/dist key), not on the varchar transaction ID | 15–20× fewer rows scanned |
| Raw time-column filters | Predicates sit directly on `txtime` / `addedon` so zone maps prune blocks. No function wraps a filter column (`CAST(txtime AS DATE)` forces a full scan) | Full-table scans avoided |
| No redundant casts | CAST/CASE removed where the column already has the right type (checked against column metadata) | Less CPU per row |
| Few, large requests | Per-identifier batching costs the same scan per batch as one full list. Identifiers go in whole | ~10 requests per run vs ~150 |
| One network match | The cross-merchant table and the prior-dispute tier come from one network scan | ~18 repeated scans removed |
| Aggregate client-side | Q2 runs as two requests (disputed-txn detail, captured side) and is aggregated in the browser, instead of six date-sliced queries that each recompute fixed parts | 20–40s unloaded |
| Variant matching | Phone matched on the raw column against `p, 91p, +91p, 0p` instead of a normalising function | 1.2–2.8× less CPU |
| Gated metadata joins | Transaction-metadata joins run only for rows that need a fallback | Large scans avoided |
| Dummy set as literals | The dummy-identifier job runs once and passes its exclusion lists to every other query as literals | No repeated dummy scans |

**8.3 Scheduling**
- One global queue of 6, the browser's connection limit. Higher concurrency was measured to add queue time without adding speed.
- The critical path (dummy-set job, then the past-dispute chain) starts first. Dependent jobs wait only for the dummy set.
- Work is split into jobs → stages → units. Units are newest-first slices, so partial results are always a recent contiguous period.

**8.4 Resilience**
- A failed or timed-out unit is retried, then halved, then marked missing. The pool never stops and never discards finished units.
- Idle workers keep polling, so all 6 slots stay busy as retries and splits appear.
- Results accumulate per unit, so a partial report holds real data from every finished unit and states what is missing.

## 9. Live results: MID 553614, 180 days
| Measure | Value |
|---|---|
| Successful transactions | 166k |
| Captured value | ₹77.2 Cr |
| Disputes | 2,123 · ₹2.58 Cr |
| High Precision Blocks | ₹1.32 Cr · 1,019 txns · 51.1% of disputed value |
| High Fraud reduction coverage Blocks | ₹1.91 Cr · 1,560 txns · 74.2% of disputed value |
| Cross-merchant past-dispute links | 2,776 rows |
| WhiteBox backtest list | 5,125 transaction IDs matched to the merchant |
| Run time | ~8–13 min, full run |
| Requests per run | ~10 |

The High Precision and coverage figures were compiled before the network past-dispute check finished. That check can only add to them.

## 10. Success metrics
- A 375k-transaction merchant completes in ≤ 10 min; a partial export is available at any moment.
- 0 silently truncated results.
- 0 internal terms in the report (lint = 0).
- The held blocked-ID list matches the tiles, with no double counting.
- Merchants can reconcile the preventable list to their own dispute records.

## 11. Risks and open items
- The network dummy-check step is the slowest, about 4–13 min under load. Options: run it only when flagged merchants exist, or time-box it.
- The launcher cannot cancel a warehouse request after the browser aborts it.
- Prevented-value figures that add back repeat attempts are an upper bound.
- Dummy-rule thresholds (1,000 txns / 10% / month) are fixed; revisit after more merchants are run.
- Pending validation: kill-at-60-seconds partial report; VPA/PAR results against a brute-force reference.

## 12. Rollout
1. Validate on 2–3 more merchants of different size and mix (UPI-heavy, low-volume).
2. Fix the final-step runtime.
3. Release to account teams as the standard enterprise proof-of-impact.
