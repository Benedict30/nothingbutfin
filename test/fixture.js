// Synthetic EDGAR companyfacts that mimics real filing quirks (see normalize.test.js).
const iso = d => d.toISOString().slice(0, 10);
const D = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);

// FY N runs Feb 1 (N-1) .. Jan 31 N; company labels it "fiscal N"
const fyStart = N => D(N - 1, 2, 1);
const qEnd = (N, q) => [null, D(N - 1, 4, 30), D(N - 1, 7, 31), D(N - 1, 10, 31), D(N, 1, 31)][q];
const qStart = (N, q) => (q === 1 ? fyStart(N) : addDays(qEnd(N, q - 1), 1));
const t = (N, q) => (N - 2020) * 4 + q; // quarter index
const wig = (N, q, k) => Math.sin(t(N, q) * 1.7 + k) * 0.04;

const truth = {
  rev: (N, q) => 1000 + (N - 2020) * 100 + q * 10,
  cfo: (N, q) => 200 + (N - 2020) * 20 + q * 3,
  eps: (N, q) => +(0.5 + (N - 2020) * 0.1 + q * 0.01).toFixed(2),
  assets: (N, q) => 5000 + (N - 2020) * 400 + q * 25,
};

// Income-statement concepts: 10-Q has 3M and YTD; 10-K has FY only.
const INCOME = {
  Revenues: truth.rev,
  CostOfRevenue: (N, q) => Math.round(truth.rev(N, q) * (0.36 + wig(N, q, 1))),
  ResearchAndDevelopmentExpense: (N, q) => Math.round(truth.rev(N, q) * (0.22 + wig(N, q, 2))),
  SellingGeneralAndAdministrativeExpense: (N, q) => Math.round(truth.rev(N, q) * (0.27 + wig(N, q, 3))),
  InterestExpense: () => 12,
  NonoperatingIncomeExpense: (N, q) => Math.round(18 + 10 * Math.sin(t(N, q))),
  IncomeTaxExpenseBenefit: (N, q) => Math.round(truth.rev(N, q) * 0.03),
  WeightedAverageNumberOfDilutedSharesOutstanding: (N, q) => 300e6 / 1e6 - t(N, q) * 0.5,
};
INCOME.GrossProfit = (N, q) => INCOME.Revenues(N, q) - INCOME.CostOfRevenue(N, q);
INCOME.OperatingIncomeLoss = (N, q) => INCOME.GrossProfit(N, q) - INCOME.ResearchAndDevelopmentExpense(N, q) - INCOME.SellingGeneralAndAdministrativeExpense(N, q);
INCOME.IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest = (N, q) =>
  INCOME.OperatingIncomeLoss(N, q) - INCOME.InterestExpense(N, q) + INCOME.NonoperatingIncomeExpense(N, q);
INCOME.NetIncomeLoss = (N, q) => INCOME.IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest(N, q) - INCOME.IncomeTaxExpenseBenefit(N, q);

// Cash-flow concepts: 10-Q has YTD only.
const CASH = {
  NetCashProvidedByUsedInOperatingActivities: truth.cfo,
  DepreciationDepletionAndAmortization: (N, q) => 40 + t(N, q),
  ShareBasedCompensation: (N, q) => 60 + t(N, q) * 1.5,
  PaymentsToAcquirePropertyPlantAndEquipment: (N, q) => Math.round(30 + 8 * Math.cos(t(N, q))),
  NetCashProvidedByUsedInInvestingActivities: (N, q) => Math.round(-80 - 40 * Math.sin(t(N, q) * 0.9)),
  PaymentsForRepurchaseOfCommonStock: (N, q) => 50 + (t(N, q) % 3) * 10,
  NetCashProvidedByUsedInFinancingActivities: (N, q) => -(60 + (t(N, q) % 3) * 10),
};
CASH.NetIncomeLoss = INCOME.NetIncomeLoss;

const BAL = {
  Assets: truth.assets,
  AssetsCurrent: (N, q) => Math.round(truth.assets(N, q) * 0.62),
  CashAndCashEquivalentsAtCarryingValue: (N, q) => Math.round(truth.assets(N, q) * 0.21),
  ShortTermInvestments: (N, q) => Math.round(truth.assets(N, q) * 0.25),
  AccountsReceivableNetCurrent: (N, q) => Math.round(truth.assets(N, q) * 0.12),
  PropertyPlantAndEquipmentNet: (N, q) => 400 + t(N, q) * 6,
  Goodwill: () => 900,
  AccountsPayableCurrent: (N, q) => Math.round(150 + 30 * Math.sin(t(N, q))),
  ContractWithCustomerLiabilityCurrent: (N, q) => Math.round(truth.assets(N, q) * 0.3),
  LiabilitiesCurrent: (N, q) => Math.round(truth.assets(N, q) * 0.38),
  LongTermDebtNoncurrent: () => 1150,
  Liabilities: (N, q) => Math.round(truth.assets(N, q) * 0.38) + 1150 + 200,
};
BAL.StockholdersEquity = (N, q) => BAL.Assets(N, q) - BAL.Liabilities(N, q);
BAL.LiabilitiesAndStockholdersEquity = BAL.Assets;

const SHARE_UNITS = { WeightedAverageNumberOfDilutedSharesOutstanding: 'shares' };

function buildFixture() {
  const facts = { 'us-gaap': {} };
  let accnN = 0;
  const put = (concept, unit, f) => {
    const c = (facts['us-gaap'][concept] ||= { label: concept, units: {} });
    (c.units[unit] ||= []).push(f);
  };
  const mult = c => (SHARE_UNITS[c] ? 1e6 : 1e6);
  const unitOf = c => SHARE_UNITS[c] || 'USD';

  function file10Q(N, q, filed) {
    const base = { accn: '0000000001-' + String(++accnN).padStart(8, '0'), fy: N, fp: 'Q' + q, form: '10-Q', filed: iso(filed) };
    for (const yr of [N, N - 1]) {
      for (const [c, fn] of Object.entries(INCOME)) {
        put(c, unitOf(c), { ...base, start: iso(qStart(yr, q)), end: iso(qEnd(yr, q)), val: Math.round(fn(yr, q) * mult(c)) });
        if (q > 1 && !SHARE_UNITS[c]) {
          let ytd = 0; for (let k = 1; k <= q; k++) ytd += fn(yr, k);
          put(c, unitOf(c), { ...base, start: iso(fyStart(yr)), end: iso(qEnd(yr, q)), val: Math.round(ytd * mult(c)) });
        }
      }
      put('EarningsPerShareDiluted', 'USD/shares', { ...base, start: iso(qStart(yr, q)), end: iso(qEnd(yr, q)), val: truth.eps(yr, q) });
      for (const [c, fn] of Object.entries(CASH)) {
        if (c === 'NetIncomeLoss') continue;
        let ytd = 0; for (let k = 1; k <= q; k++) ytd += fn(yr, k);
        put(c, 'USD', { ...base, start: iso(fyStart(yr)), end: iso(qEnd(yr, q)), val: Math.round(ytd * 1e6) });
      }
    }
    for (const [c, fn] of Object.entries(BAL)) {
      put(c, 'USD', { ...base, end: iso(qEnd(N, q)), val: Math.round(fn(N, q) * 1e6) });
      put(c, 'USD', { ...base, end: iso(qEnd(N - 1, 4)), val: Math.round(fn(N - 1, 4) * 1e6) });
    }
  }
  function file10K(N, filed, restate = {}) {
    const base = { accn: '0000000001-' + String(++accnN).padStart(8, '0'), fy: N, fp: 'FY', form: '10-K', filed: iso(filed) };
    for (const yr of [N, N - 1, N - 2]) {
      for (const [c, fn] of Object.entries({ ...INCOME, ...CASH })) {
        if (SHARE_UNITS[c]) continue;
        let v = 0; for (let k = 1; k <= 4; k++) v += fn(yr, k);
        if (c === 'Revenues' && restate[yr]) v = restate[yr];
        put(c, 'USD', { ...base, start: iso(fyStart(yr)), end: iso(qEnd(yr, 4)), val: Math.round(v * 1e6) });
      }
      put('EarningsPerShareDiluted', 'USD/shares', { ...base, start: iso(fyStart(yr)), end: iso(qEnd(yr, 4)),
        val: +(truth.eps(yr, 1) + truth.eps(yr, 2) + truth.eps(yr, 3) + truth.eps(yr, 4)).toFixed(2) });
    }
    for (const yr of [N, N - 1]) for (const [c, fn] of Object.entries(BAL)) put(c, 'USD', { ...base, end: iso(qEnd(yr, 4)), val: Math.round(fn(yr, 4) * 1e6) });
  }

  for (let N = 2021; N <= 2025; N++) {
    for (let q = 1; q <= 3; q++) file10Q(N, q, addDays(qEnd(N, q), 35));
    file10K(N, addDays(qEnd(N, 4), 60), N === 2025 ? { 2023: 9999 } : {});
  }
  file10Q(2026, 1, addDays(qEnd(2026, 1), 35));
  file10Q(2026, 2, addDays(qEnd(2026, 2), 35));
  return { cik: 1, entityName: 'Testco Industries Inc.', facts };
}

module.exports = { buildFixture, truth };
