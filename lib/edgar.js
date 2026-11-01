/*
 * edgar.js — turn SEC EDGAR "companyfacts" JSON into Income Statement,
 * Balance Sheet and Cash Flow tables (quarterly + annual).
 *
 * Works in Node (require) and in the browser (window.EdgarStatements).
 * No dependencies.
 *
 * What it handles:
 *  - Fiscal calendar: fiscal years and quarter ends are read from the
 *    company's own 10-K / 10-Q filings (52/53-week years, odd year-ends).
 *  - Fiscal years are numbered per the company's own DocumentFiscalYearFocus
 *    (period.fy / period.q), but column labels are calendar periods: the
 *    calendar quarter / year a period mostly falls in (end − 45 days).
 *  - Duplicates: the same number appears in many filings (comparatives,
 *    restatements). The most recently filed value wins.
 *  - Flow items (income, cash flow): Q4 and YTD-only quarters are derived
 *    (Q2 = 6M − 3M, Q3 = 9M − 6M, Q4 = FY − 9M).
 *  - Stock items (balance sheet): point-in-time value at period end.
 *  - Tag changes over time: each line item has a list of candidate tags.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EdgarStatements = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- dates
  const DAY = 86400000;
  const ms = s => Date.parse(s + 'T00:00:00Z');
  const daysBetween = (a, b) => Math.round((ms(b) - ms(a)) / DAY);
  const calDate = end => new Date(ms(end) - 45 * DAY);
  const calYear = end => calDate(end).getUTCFullYear();
  const calQuarter = end => 'Q' + (Math.floor(calDate(end).getUTCMonth() / 3) + 1) + ' ' + calYear(end);
  const shiftMemo = new Map();
  function shift(s, n) {
    if (n === 0) return s;
    const k = s + '|' + n;
    let r = shiftMemo.get(k);
    if (r === undefined) {
      r = new Date(ms(s) + n * DAY).toISOString().slice(0, 10);
      if (shiftMemo.size > 200000) shiftMemo.clear();
      shiftMemo.set(k, r);
    }
    return r;
  }
  const TOL_ORDER = [0, -1, 1, -2, 2, -3, 3];

  const ANNUAL_FORMS = new Set(['10-K', '10-K/A', '10-KT', '10-KT/A', '20-F', '20-F/A', '40-F', '40-F/A']);
  const QUARTER_FORMS = new Set(['10-Q', '10-Q/A', '10-QT', '10-QT/A']);
  const isAnnualForm = f => ANNUAL_FORMS.has(f);
  const isQuarterForm = f => QUARTER_FORMS.has(f);
  const isAmendment = f => /\/A$/.test(f);

  // ------------------------------------------------------- line items
  // concepts: candidate tags in priority order ("ifrs-full:" prefix for IFRS).
  // pick: 'first' (first tag with a value) or 'max' (largest — used for revenue,
  //       where companies switch between total and contract-revenue tags).
  // sign: -1 shows outflows (payments) as negatives.
  // derive: fallback formula over other items when no tag has a value.
  // perShare / shares: not additive, so no YTD subtraction (EPS Q4 is approximated).
  const MONEY = 'money', PER_SHARE = 'perShare', SHARES = 'shares';
  const sub = (a, b) => (a == null || b == null ? null : a - b);
  const add = (...xs) => (xs.some(x => x == null) ? null : xs.reduce((s, x) => s + x, 0));

  const ITEMS = [
    // ---------------- Income statement
    { key: 'revenue', st: 'income', name: 'Total Revenue', total: 1, pick: 'max',
      concepts: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax',
        'SalesRevenueNet', 'SalesRevenueGoodsNet', 'SalesRevenueServicesNet', 'RevenuesNetOfInterestExpense',
        'RegulatedAndUnregulatedOperatingRevenue', 'ifrs-full:Revenue', 'ifrs-full:RevenueFromContractsWithCustomers'] },
    { key: 'cogs', st: 'income', name: 'Cost of Revenue',
      concepts: ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold', 'CostOfServices',
        'CostOfGoodsAndServiceExcludingDepreciationDepletionAndAmortization', 'CostOfGoodsSoldExcludingDepreciationDepletionAndAmortization',
        'ifrs-full:CostOfSales'] },
    { key: 'grossProfit', st: 'income', name: 'Gross Profit', total: 1,
      concepts: ['GrossProfit', 'ifrs-full:GrossProfit'],
      derive: v => sub(v.revenue, v.cogs), deriveNote: 'Revenue − Cost of Revenue' },
    { key: 'rnd', st: 'income', name: 'Research & Development',
      concepts: ['ResearchAndDevelopmentExpense', 'ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost', 'ifrs-full:ResearchAndDevelopmentExpense'] },
    { key: '_sm', hidden: 1, concepts: ['SellingAndMarketingExpense', 'ifrs-full:SellingExpense', 'ifrs-full:DistributionCosts'] },
    { key: '_ga', hidden: 1, concepts: ['GeneralAndAdministrativeExpense', 'ifrs-full:AdministrativeExpense'] },
    { key: 'sga', st: 'income', name: 'Selling, General & Administrative',
      concepts: ['SellingGeneralAndAdministrativeExpense', 'ifrs-full:SellingGeneralAndAdministrativeExpense'],
      derive: v => add(v._sm, v._ga), deriveNote: 'Selling & Marketing + General & Administrative' },
    { key: 'opex', st: 'income', name: 'Total Operating Expenses', concepts: ['OperatingExpenses', 'ifrs-full:OperatingExpense'] },
    { key: 'opIncome', st: 'income', name: 'Operating Income', total: 1,
      concepts: ['OperatingIncomeLoss', 'ifrs-full:ProfitLossFromOperatingActivities'] },
    { key: 'interestExp', st: 'income', name: 'Interest Expense',
      concepts: ['InterestExpense', 'InterestExpenseNonoperating', 'InterestExpenseDebt', 'ifrs-full:FinanceCosts'] },
    { key: 'nonOp', st: 'income', name: 'Non-Operating Income (Expense)',
      concepts: ['NonoperatingIncomeExpense', 'OtherNonoperatingIncomeExpense'] },
    { key: 'pretax', st: 'income', name: 'Income Before Taxes', total: 1,
      concepts: ['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
        'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments',
        'IncomeLossFromContinuingOperationsBeforeIncomeTaxesForeignAndDomestic', 'ifrs-full:ProfitLossBeforeTax'] },
    { key: 'tax', st: 'income', name: 'Income Taxes',
      concepts: ['IncomeTaxExpenseBenefit', 'ifrs-full:IncomeTaxExpenseContinuingOperations'] },
    { key: 'contOps', st: 'income', name: 'Net Income From Continuing Operations',
      concepts: ['IncomeLossFromContinuingOperations', 'ifrs-full:ProfitLossFromContinuingOperations'] },
    { key: 'netIncome', st: 'income', name: 'Net Income', total: 1,
      concepts: ['NetIncomeLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic', 'ProfitLoss',
        'ifrs-full:ProfitLossAttributableToOwnersOfParent', 'ifrs-full:ProfitLoss'] },
    { key: 'epsBasic', st: 'income', name: 'EPS (Basic)', unit: PER_SHARE,
      concepts: ['EarningsPerShareBasic', 'EarningsPerShareBasicAndDiluted', 'ifrs-full:BasicEarningsLossPerShare'] },
    { key: 'epsDiluted', st: 'income', name: 'EPS (Diluted)', unit: PER_SHARE,
      concepts: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted', 'ifrs-full:DilutedEarningsLossPerShare'] },
    { key: 'sharesBasic', st: 'income', name: 'Weighted Avg. Shares (Basic, M)', unit: SHARES,
      concepts: ['WeightedAverageNumberOfSharesOutstandingBasic', 'ifrs-full:WeightedAverageShares'] },
    { key: 'sharesDiluted', st: 'income', name: 'Weighted Avg. Shares (Diluted, M)', unit: SHARES,
      concepts: ['WeightedAverageNumberOfDilutedSharesOutstanding', 'ifrs-full:AdjustedWeightedAverageShares'] },
    { key: 'ebitda', st: 'income', name: 'EBITDA', total: 1,
      derive: v => add(v.opIncome, v.da), deriveNote: 'Operating Income + D&A (from cash flow statement)' },

    // ---------------- Balance sheet
    { key: 'cash', st: 'balance', name: 'Cash & Equivalents',
      concepts: ['CashAndCashEquivalentsAtCarryingValue', 'Cash', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
        'ifrs-full:CashAndCashEquivalents'] },
    { key: 'stInv', st: 'balance', name: 'Short-Term Investments',
      concepts: ['ShortTermInvestments', 'MarketableSecuritiesCurrent', 'AvailableForSaleSecuritiesDebtSecuritiesCurrent',
        'AvailableForSaleSecuritiesCurrent', 'ifrs-full:CurrentInvestments'] },
    { key: 'receivables', st: 'balance', name: 'Accounts Receivable',
      concepts: ['AccountsReceivableNetCurrent', 'ReceivablesNetCurrent', 'ifrs-full:TradeAndOtherCurrentReceivables'] },
    { key: 'inventory', st: 'balance', name: 'Inventory', concepts: ['InventoryNet', 'ifrs-full:Inventories'] },
    { key: 'curAssets', st: 'balance', name: 'Total Current Assets', total: 1, concepts: ['AssetsCurrent', 'ifrs-full:CurrentAssets'] },
    { key: 'ppe', st: 'balance', name: 'Property, Plant & Equipment (Net)',
      concepts: ['PropertyPlantAndEquipmentNet', 'PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization',
        'ifrs-full:PropertyPlantAndEquipment'] },
    { key: 'goodwill', st: 'balance', name: 'Goodwill', concepts: ['Goodwill', 'ifrs-full:Goodwill'] },
    { key: 'intangibles', st: 'balance', name: 'Intangible Assets (Net)',
      concepts: ['IntangibleAssetsNetExcludingGoodwill', 'FiniteLivedIntangibleAssetsNet', 'ifrs-full:IntangibleAssetsOtherThanGoodwill'] },
    { key: 'assets', st: 'balance', name: 'Total Assets', total: 1, concepts: ['Assets', 'ifrs-full:Assets'] },
    { key: 'payables', st: 'balance', name: 'Accounts Payable',
      concepts: ['AccountsPayableCurrent', 'AccountsPayableAndAccruedLiabilitiesCurrent', 'ifrs-full:TradeAndOtherCurrentPayables'] },
    { key: 'defRev', st: 'balance', name: 'Deferred Revenue (Current)',
      concepts: ['ContractWithCustomerLiabilityCurrent', 'DeferredRevenueCurrent'] },
    { key: 'stDebt', st: 'balance', name: 'Short-Term Debt',
      concepts: ['DebtCurrent', 'LongTermDebtCurrent', 'ShortTermBorrowings', 'CommercialPaper'] },
    { key: 'curLiab', st: 'balance', name: 'Total Current Liabilities', total: 1,
      concepts: ['LiabilitiesCurrent', 'ifrs-full:CurrentLiabilities'] },
    { key: 'ltDebt', st: 'balance', name: 'Long-Term Debt',
      concepts: ['LongTermDebtNoncurrent', 'LongTermDebtAndCapitalLeaseObligations', 'LongTermDebt'] },
    { key: '_le', hidden: 1, concepts: ['LiabilitiesAndStockholdersEquity', 'ifrs-full:EquityAndLiabilities'] },
    { key: '_eqAll', hidden: 1, concepts: ['StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest', 'ifrs-full:Equity'] },
    { key: 'liabilities', st: 'balance', name: 'Total Liabilities', total: 1,
      concepts: ['Liabilities', 'ifrs-full:Liabilities'],
      derive: v => sub(v._le, v._eqAll != null ? v._eqAll : v.equity), deriveNote: 'Total Liabilities & Equity − Total Equity' },
    { key: 'equity', st: 'balance', name: 'Total Shareholders’ Equity', total: 1,
      concepts: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
        'ifrs-full:EquityAttributableToOwnersOfParent', 'ifrs-full:Equity'] },
    { key: 'liabEquity', st: 'balance', name: 'Total Liabilities & Equity', total: 1,
      concepts: ['LiabilitiesAndStockholdersEquity', 'ifrs-full:EquityAndLiabilities'] },

    // ---------------- Cash flow
    { key: 'cfNetIncome', st: 'cash', name: 'Net Income',
      concepts: ['ProfitLoss', 'NetIncomeLoss', 'ifrs-full:ProfitLoss'] },
    { key: 'da', st: 'cash', name: 'Depreciation & Amortization',
      concepts: ['DepreciationDepletionAndAmortization', 'DepreciationAmortizationAndAccretionNet', 'DepreciationAndAmortization',
        'Depreciation', 'ifrs-full:DepreciationAndAmortisationExpense'] },
    { key: 'sbc', st: 'cash', name: 'Stock-Based Compensation',
      concepts: ['ShareBasedCompensation', 'AllocatedShareBasedCompensationExpense'] },
    { key: 'cfo', st: 'cash', name: 'Cash From Operating Activities', total: 1,
      concepts: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
        'ifrs-full:CashFlowsFromUsedInOperatingActivities'] },
    { key: 'capex', st: 'cash', name: 'Capital Expenditures', sign: -1,
      concepts: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets',
        'ifrs-full:PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities', 'ifrs-full:PurchaseOfPropertyPlantAndEquipment'] },
    { key: 'acq', st: 'cash', name: 'Acquisitions (Net of Cash)', sign: -1,
      concepts: ['PaymentsToAcquireBusinessesNetOfCashAcquired'] },
    { key: 'cfi', st: 'cash', name: 'Cash From Investing Activities', total: 1,
      concepts: ['NetCashProvidedByUsedInInvestingActivities', 'NetCashProvidedByUsedInInvestingActivitiesContinuingOperations',
        'ifrs-full:CashFlowsFromUsedInInvestingActivities'] },
    { key: 'buybacks', st: 'cash', name: 'Share Repurchases', sign: -1,
      concepts: ['PaymentsForRepurchaseOfCommonStock', 'ifrs-full:PaymentsToAcquireOrRedeemEntitysShares'] },
    { key: 'dividends', st: 'cash', name: 'Dividends Paid', sign: -1,
      concepts: ['PaymentsOfDividends', 'PaymentsOfDividendsCommonStock', 'ifrs-full:DividendsPaidClassifiedAsFinancingActivities'] },
    { key: 'debtIssued', st: 'cash', name: 'Debt Issued', concepts: ['ProceedsFromIssuanceOfLongTermDebt'] },
    { key: 'debtRepaid', st: 'cash', name: 'Debt Repaid', sign: -1, concepts: ['RepaymentsOfLongTermDebt'] },
    { key: 'cff', st: 'cash', name: 'Cash From Financing Activities', total: 1,
      concepts: ['NetCashProvidedByUsedInFinancingActivities', 'NetCashProvidedByUsedInFinancingActivitiesContinuingOperations',
        'ifrs-full:CashFlowsFromUsedInFinancingActivities'] },
    { key: 'fcf', st: 'cash', name: 'Free Cash Flow', total: 1,
      derive: v => add(v.cfo, v.capex), deriveNote: 'Cash From Operations − Capital Expenditures' },
  ];

  const STATEMENTS = [
    { key: 'income', label: 'Income Statement', kind: 'flow' },
    { key: 'balance', label: 'Balance Sheet', kind: 'stock' },
    { key: 'cash', label: 'Cash Flow', kind: 'flow' },
  ];
  const KIND = { income: 'flow', balance: 'stock', cash: 'flow' };
  // Hidden helper items take the kind of the statement they support.
  const HIDDEN_KIND = { _sm: 'flow', _ga: 'flow', _le: 'stock', _eqAll: 'stock' };
  const kindOf = it => (it.st ? KIND[it.st] : HIDDEN_KIND[it.key]);

  // ----------------------------------------------------- fact access
  function parseConcept(c) {
    const i = c.indexOf(':');
    return i < 0 ? ['us-gaap', c] : [c.slice(0, i), c.slice(i + 1)];
  }

  // Series = all facts of one concept in one unit, from 10-K/10-Q type forms,
  // indexed by end date and split into instant vs duration facts.
  function makeSeriesCache(facts) {
    const cache = new Map();
    return function series(concept, unit) {
      const key = concept + '@' + unit;
      if (cache.has(key)) return cache.get(key);
      const [ns, name] = parseConcept(concept);
      const raw = facts[ns] && facts[ns][name] && facts[ns][name].units && facts[ns][name].units[unit];
      let s = null;
      if (raw && raw.length) {
        s = { concept: (ns === 'us-gaap' ? '' : ns + ':') + name, inst: new Map(), dur: new Map() };
        for (const f of raw) {
          if (!f.end || typeof f.val !== 'number') continue;
          if (!(isAnnualForm(f.form) || isQuarterForm(f.form))) continue;
          const m = f.start ? s.dur : s.inst;
          const rec = { start: f.start || null, end: f.end, val: f.val, filed: f.filed || '', form: f.form,
            len: f.start ? daysBetween(f.start, f.end) + 1 : 0 };
          const a = m.get(f.end);
          if (a) a.push(rec); else m.set(f.end, [rec]);
        }
      }
      cache.set(key, s);
      return s;
    };
  }

  // Latest-filed fact whose end date is nearest the target (±3 days) and passes ok().
  function lookup(map, end, ok) {
    for (const k of TOL_ORDER) {
      const arr = map.get(shift(end, k));
      if (!arr) continue;
      let best = null;
      for (const f of arr) if (ok(f) && (!best || f.filed > best.filed)) best = f;
      if (best) return best;
    }
    return null;
  }

  const near = (a, b, tol) => a && b && Math.abs(daysBetween(a, b)) <= tol;

  // ------------------------------------------------- fiscal calendar
  function buildCalendar(facts) {
    // 1. Group facts by filing (accession number).
    const filings = new Map();
    for (const ns of Object.keys(facts)) {
      if (ns === 'dei') continue; // cover-page facts carry later "as of" dates
      const conceptMap = facts[ns];
      for (const name of Object.keys(conceptMap)) {
        const units = conceptMap[name].units || {};
        for (const u of Object.keys(units)) {
          for (const f of units[u]) {
            if (!f.accn || !f.end || !(isAnnualForm(f.form) || isQuarterForm(f.form))) continue;
            let r = filings.get(f.accn);
            if (!r) filings.set(f.accn, (r = { accn: f.accn, form: f.form, fy: f.fy, fp: f.fp, filed: f.filed || '', ends: new Map(), durs: new Map() }));
            r.ends.set(f.end, (r.ends.get(f.end) || 0) + 1);
            if (f.start) {
              const k = f.start + '|' + f.end;
              r.durs.set(k, (r.durs.get(k) || 0) + 1);
            }
          }
        }
      }
    }

    // 2. Each filing's own period end = latest end date used by ≥3 facts (and not after filing date).
    const list = [];
    for (const r of filings.values()) {
      let pe = null, peAny = null;
      for (const [e, c] of r.ends) {
        if (r.filed && e > r.filed) continue;
        if (!peAny || e > peAny) peAny = e;
        if (c >= 3 && (!pe || e > pe)) pe = e;
      }
      r.periodEnd = pe || peAny;
      if (!r.periodEnd) continue;
      r.durList = [];
      for (const [k, c] of r.durs) {
        const [s, e] = k.split('|');
        r.durList.push({ s, e, c, len: daysBetween(s, e) + 1 });
      }
      delete r.durs;
      list.push(r);
    }
    const annualFilings = list.filter(r => isAnnualForm(r.form));
    const quarterFilings = list.filter(r => isQuarterForm(r.form));

    // 3. Fiscal-year candidates: 340–390-day periods in annual filings.
    //    Current-period ones carry a big weight; comparatives a small one.
    const fyCands = []; // {end, start, w}
    for (const r of annualFilings) {
      for (const d of r.durList) {
        if (d.len < 340 || d.len > 390) continue;
        const current = near(d.e, r.periodEnd, 3);
        fyCands.push({ end: d.e, start: d.s, w: (current ? 1000 : 1) * d.c * (isAmendment(r.form) ? 0.5 : 1) });
      }
    }
    // Cluster by end date (±10 days), choose the heaviest end and start.
    fyCands.sort((a, b) => (a.end < b.end ? -1 : 1));
    const years = [];
    for (const c of fyCands) {
      const last = years[years.length - 1];
      if (last && Math.abs(daysBetween(last.anchor, c.end)) <= 10) last.items.push(c);
      else years.push({ anchor: c.end, items: [c] });
    }
    const cands = years.map(g => {
      const endW = new Map(), startW = new Map();
      let w = 0;
      for (const c of g.items) {
        endW.set(c.end, (endW.get(c.end) || 0) + c.w);
        startW.set(c.start, (startW.get(c.start) || 0) + c.w);
        w += c.w;
      }
      const top = m => [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return { start: top(startW), end: top(endW), closed: true, w };
    });
    // Some filers also tag 12-month periods that are not their fiscal year (e.g. a
    // subsidiary consolidated on a calendar-year basis). Keep the best-supported
    // year wherever two candidates overlap by more than a month.
    const overlap = (a, b) => (Math.min(ms(a.end), ms(b.end)) - Math.max(ms(a.start), ms(b.start))) / DAY > 30;
    const fys = [];
    for (const c of cands.sort((a, b) => b.w - a.w)) if (!fys.some(y => overlap(y, c))) fys.push(c);
    fys.sort((a, b) => (a.end < b.end ? -1 : 1));

    // 4. Open fiscal year(s): quarters filed after the last known year-end,
    //    or companies that have only filed 10-Qs so far.
    const fyStartCands = new Map(); // start -> weight, from YTD (170–290 day) periods in 10-Qs
    for (const r of quarterFilings) {
      for (const d of r.durList) {
        if (d.len >= 170 && d.len <= 290 && near(d.e, r.periodEnd, 3)) fyStartCands.set(d.s, (fyStartCands.get(d.s) || 0) + d.c);
      }
    }
    const inKnownYear = s => fys.some(y => ms(s) >= ms(y.start) - 5 * DAY && ms(s) <= ms(y.end));
    const lastEnd = fys.length ? fys[fys.length - 1].end : null;
    const lateQuarters = quarterFilings.filter(r => !lastEnd || r.periodEnd > lastEnd);
    if (lateQuarters.length) {
      let start = lastEnd ? shift(lastEnd, 1) : null;
      if (!start) {
        // No 10-K yet: infer the fiscal year start from YTD periods.
        const starts = [...fyStartCands.entries()].filter(([s]) => !inKnownYear(s)).sort((a, b) => b[1] - a[1]);
        if (starts.length) start = starts[0][0];
        else {
          // Only a Q1 10-Q: its 3-month period starts the fiscal year.
          const r = lateQuarters.sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : 1))[0];
          const d = r.durList.filter(x => x.len >= 80 && x.len <= 100 && near(x.e, r.periodEnd, 3)).sort((a, b) => b.c - a.c)[0];
          if (d) start = d.s;
        }
      }
      if (start) fys.push({ start, end: null, closed: false });
    }
    if (!fys.length) return { years: [], quarters: [] };

    // 5. Fiscal-year labels. Offset = filing fy − calendar year of (year end − 45 days),
    //    taken as the most common offset across original annual filings.
    const labelYear = calYear;
    const offsetVotes = new Map();
    for (const r of annualFilings) {
      if (isAmendment(r.form) || !r.fy) continue;
      const o = r.fy - labelYear(r.periodEnd);
      if (Math.abs(o) <= 1) offsetVotes.set(o, (offsetVotes.get(o) || 0) + 1);
    }
    if (!offsetVotes.size) {
      for (const r of quarterFilings) {
        if (!r.fy) continue;
        const y = fys.find(y => ms(r.periodEnd) >= ms(y.start) && (!y.end || ms(r.periodEnd) <= ms(y.end)));
        if (!y) continue;
        const o = r.fy - labelYear(y.end || shift(y.start, 364));
        if (Math.abs(o) <= 1) offsetVotes.set(o, (offsetVotes.get(o) || 0) + 1);
      }
    }
    const offset = offsetVotes.size ? [...offsetVotes.entries()].sort((a, b) => b[1] - a[1])[0][0] : 0;
    for (const y of fys) y.fy = labelYear(y.end || shift(y.start, 364)) + offset;

    // 6. Quarter ends inside each fiscal year, from 10-Q periods (current + comparatives).
    const qCands = []; // {end, w}
    for (const r of quarterFilings) {
      qCands.push({ end: r.periodEnd, w: 1000 });
      for (const d of r.durList) if (d.len >= 80 && d.len <= 290) qCands.push({ end: d.e, w: d.c });
    }
    const quarters = [];
    for (const y of fys) {
      const sMs = ms(y.start), eMs = y.end ? ms(y.end) : sMs + 400 * DAY;
      const pos = [null, new Map(), new Map(), new Map()];
      for (const c of qCands) {
        const t = ms(c.end);
        if (t < sMs + 60 * DAY || t > eMs - 30 * DAY) continue;
        const n = Math.round((t - sMs) / DAY / 91.3);
        if (n < 1 || n > 3) continue;
        pos[n].set(c.end, (pos[n].get(c.end) || 0) + c.w);
      }
      y.qEnds = [null, null, null, null, y.end || null];
      for (let n = 1; n <= 3; n++) {
        if (!pos[n].size) continue;
        // merge dates within ±3 days, keep heaviest
        const arr = [...pos[n].entries()].sort((a, b) => b[1] - a[1]);
        y.qEnds[n] = arr[0][0];
      }
      // Annual-only filers (20-F/40-F, or years before quarterly filing) get no quarters.
      if (!y.qEnds[1] && !y.qEnds[2] && !y.qEnds[3]) continue;
      for (let n = 1; n <= 4; n++) {
        if (!y.qEnds[n]) continue;
        quarters.push({ fy: y.fy, q: n, end: y.qEnds[n], year: y });
      }
    }
    return { years: fys, quarters };
  }

  // --------------------------------------------- value resolution
  // Flow concept over a fiscal-year-to-date window ending at quarter n.
  function cumulative(s, y, n) {
    const end = y.qEnds[n];
    if (!end) return null;
    if (n === 4) {
      const f = lookup(s.dur, end, f => f.len >= 340 && f.len <= 390);
      return f ? { val: f.val, f } : null;
    }
    const f = lookup(s.dur, end, f => near(f.start, y.start, 5));
    return f ? { val: f.val, f } : null;
  }

  function discreteQuarter(s, y, n, nonAdditive) {
    const end = y.qEnds[n];
    const direct = lookup(s.dur, end, f => f.len >= 80 && f.len <= 100);
    if (direct) return { val: direct.val, src: srcOf(s, direct) };
    if (n === 1) {
      const c = cumulative(s, y, 1);
      return c ? { val: c.val, src: srcOf(s, c.f) } : null;
    }
    // Derive from year-to-date figures: Qn = YTD(n) − YTD(n−1)
    const cur = cumulative(s, y, n);
    if (!cur) return null;
    let prev = cumulative(s, y, n - 1);
    if (!prev && n - 1 >= 1) {
      // previous YTD may itself be missing but discrete quarters present
      let sum = 0, ok = true;
      for (let k = 1; k < n; k++) {
        const e = y.qEnds[k];
        const d = e && lookup(s.dur, e, f => f.len >= 80 && f.len <= 100);
        if (!d) { ok = false; break; }
        sum += d.val;
      }
      if (ok) prev = { val: sum };
    }
    if (!prev) return null;
    const lbl = { 2: '6M', 3: '9M', 4: 'FY' }[n] + ' − ' + { 1: '3M', 2: '6M', 3: '9M' }[n - 1];
    return {
      val: cur.val - prev.val,
      src: srcOf(s, cur.f) + ' · derived: ' + lbl + ' YTD' + (nonAdditive ? ' (approximate for per-share data)' : ''),
      derived: true,
    };
  }

  function srcOf(s, f) {
    return (s.concept || '') + ' · ' + f.form + ' filed ' + f.filed;
  }

  function resolveConcept(s, kind, unitKind, period) {
    if (kind === 'stock') {
      const f = lookup(s.inst, period.end, () => true);
      return f ? { val: f.val, src: srcOf(s, f) } : null;
    }
    if (period.type === 'A') {
      const f = lookup(s.dur, period.end, f => f.len >= 340 && f.len <= 390);
      return f ? { val: f.val, src: srcOf(s, f) } : null;
    }
    // quarterly flow
    if (unitKind === SHARES) {
      const f = lookup(s.dur, period.end, f => f.len >= 80 && f.len <= 100);
      return f ? { val: f.val, src: srcOf(s, f) } : null;
    }
    return discreteQuarter(s, period.year, period.q, unitKind === PER_SHARE);
  }

  // ------------------------------------------------------- main
  // Reporting currency = the unit most facts use. Foreign filers (e.g. TSMC, Alibaba)
  // also tag a few USD "convenience translations"; those must not win.
  function pickCurrency(facts) {
    const tries = ['us-gaap:Assets', 'ifrs-full:Assets', 'us-gaap:NetIncomeLoss', 'ifrs-full:ProfitLoss'];
    for (const t of tries) {
      const [ns, n] = parseConcept(t);
      const u = facts[ns] && facts[ns][n] && facts[ns][n].units;
      if (!u) continue;
      const cands = Object.keys(u).filter(k => !/shares|pure/i.test(k))
        .sort((a, b) => u[b].length - u[a].length || (a === 'USD' ? -1 : b === 'USD' ? 1 : 0));
      if (cands.length) return cands[0];
    }
    return 'USD';
  }

  function normalize(companyFacts, opts = {}) {
    const facts = (companyFacts && companyFacts.facts) || {};
    const currency = pickCurrency(facts);
    const series = makeSeriesCache(facts);
    const cal = buildCalendar(facts);
    const unitName = u => (u === PER_SHARE ? currency + '/shares' : u === SHARES ? 'shares' : currency);
    const scale = u => (u === PER_SHARE ? 1 : 1e6);

    const annualPeriods = cal.years.filter(y => y.closed).map(y => ({
      type: 'A', key: 'FY' + y.fy, label: String(calYear(y.end)), fy: y.fy, start: y.start, end: y.end, year: y,
      months: Math.round((daysBetween(y.start, y.end) + 1) / 30.44),
    }));
    const quarterPeriods = cal.quarters.map(q => ({
      type: 'Q', key: q.fy + 'Q' + q.q, label: calQuarter(q.end), fy: q.fy, q: q.q, end: q.end, year: q.year,
      months: 3,
    }));

    function computeAll(periods) {
      // values[itemKey][i] = {val, src} | null
      const values = {};
      for (const it of ITEMS) {
        values[it.key] = periods.map(() => null);
        if (!it.concepts) continue;
        const kind = kindOf(it), unitKind = it.unit || MONEY;
        const seriesList = it.concepts.map(c => series(c, unitName(unitKind))).filter(Boolean);
        if (!seriesList.length) continue;
        periods.forEach((p, i) => {
          let chosen = null;
          for (const s of seriesList) {
            const r = resolveConcept(s, kind, unitKind, p);
            if (!r) continue;
            if (it.pick === 'max') { if (!chosen || r.val > chosen.val) chosen = r; }
            else { chosen = r; break; }
          }
          if (chosen) values[it.key][i] = { val: chosen.val / scale(unitKind) * (it.sign || 1), src: chosen.src, derived: chosen.derived };
        });
      }
      // Derived items (fallback formulas), in ITEMS order.
      for (const it of ITEMS) {
        if (!it.derive) continue;
        periods.forEach((p, i) => {
          if (values[it.key][i]) return;
          const v = {};
          for (const k of Object.keys(values)) v[k] = values[k][i] ? values[k][i].val : null;
          const r = it.derive(v);
          if (r != null && isFinite(r)) values[it.key][i] = { val: r, src: 'derived: ' + it.deriveNote, derived: true };
        });
      }
      return values;
    }

    function build(periods) {
      const values = computeAll(periods);
      // Drop periods with no visible data at all.
      const visibleItems = ITEMS.filter(it => !it.hidden);
      const filled = periods.map((_, i) => visibleItems.filter(it => values[it.key][i]).length);
      // one column per label; if a label repeats, keep the column with more data
      const byLabel = new Map();
      periods.forEach((p, i) => {
        if (!filled[i]) return;
        const j = byLabel.get(p.label);
        if (j == null || filled[i] > filled[j]) byLabel.set(p.label, i);
      });
      const idx = [...byLabel.values()];
      // newest first
      idx.sort((a, b) => (periods[a].end < periods[b].end ? 1 : -1));
      const outPeriods = idx.map(i => {
        const p = periods[i];
        const o = { key: p.key, label: p.label, fy: p.fy, end: p.end, months: p.months };
        if (p.type === 'Q') o.q = p.q;
        return o;
      });
      const statements = {};
      for (const st of STATEMENTS) {
        statements[st.key] = {
          label: st.label,
          kind: st.kind,
          rows: visibleItems.filter(it => it.st === st.key).map(it => ({
            key: it.key,
            name: it.name,
            total: !!it.total,
            unit: it.unit || MONEY,
            vals: idx.map(i => (values[it.key][i] ? round(values[it.key][i].val, it.unit === PER_SHARE ? 4 : 3) : null)),
            src: opts.provenance === false ? undefined : idx.map(i => (values[it.key][i] ? values[it.key][i].src : null)),
          })),
        };
      }
      return { periods: outPeriods, statements };
    }

    const quarterly = build(quarterPeriods);
    const annual = build(annualPeriods);
    addTtm(quarterly, annual);
    addProjection(quarterly, annual);
    const lastYear = cal.years.filter(y => y.closed).slice(-1)[0];
    return {
      company: {
        cik: companyFacts.cik,
        name: companyFacts.entityName,
        fiscalYearEnd: lastYear ? lastYear.end.slice(5) : null,
      },
      currency,
      units: { money: currency + ' millions', perShare: currency + ' per share', shares: 'millions of shares' },
      quarterly,
      annual,
    };
  }

  // Trailing twelve months: the last four quarters, shown first in the annual block when
  // they run past the latest fiscal year. Flows (income, cash flow, EPS) are summed,
  // balance-sheet items are the latest quarter, share counts are averaged. Each row also
  // gets ttmYearAgo (the same measure four quarters earlier) for year-on-year growth.
  function addTtm(quarterly, annual) {
    const q = quarterly.periods;
    if (q.length < 4 || !annual.periods.length || q[0].end <= annual.periods[0].end) return;
    const seq = p => p.fy * 4 + p.q;
    const consecutive = i => q.length >= i + 4 && [1, 2, 3].every(k => seq(q[i + k - 1]) - seq(q[i + k]) === 1);
    if (!consecutive(0)) return;
    const yearAgoOk = consecutive(4) && seq(q[3]) - seq(q[4]) === 1;
    const span = i => q[i + 3].label + ' – ' + q[i].label;
    annual.periods.unshift({ key: 'TTM', label: 'TTM', fy: null, end: q[0].end, months: 12 });
    for (const st of STATEMENTS) {
      const qRows = new Map(quarterly.statements[st.key].rows.map(r => [r.key, r]));
      for (const ar of annual.statements[st.key].rows) {
        const qr = qRows.get(ar.key);
        const four = i => { const v = qr ? qr.vals.slice(i, i + 4) : []; return v.length === 4 && v.every(x => x != null) ? v : null; };
        const at = i => {
          if (st.kind === 'stock') return qr ? qr.vals[i] : null;
          const v = four(i);
          if (!v) return null;
          const sum = v.reduce((a, b) => a + b, 0);
          return round(ar.unit === SHARES ? sum / 4 : sum, ar.unit === PER_SHARE ? 4 : 3);
        };
        const val = at(0);
        ar.vals.unshift(val);
        if (ar.src) {
          ar.src.unshift(val == null ? null
            : st.kind === 'stock' ? 'TTM: latest quarter (' + q[0].label + ')'
            : 'TTM: ' + (ar.unit === SHARES ? 'average' : 'sum') + ' of ' + span(0) + (ar.unit === PER_SHARE ? ' (approximate for per-share data)' : ''));
        }
        ar.ttmYearAgo = yearAgoOk ? at(4) : null;
      }
    }
  }

  /**
   * "FY… (projected)": while a fiscal year is under way, its quarters reported so far plus the rest
   * projected at the latest quarter-on-quarter growth rate, compounding: with Q1 and Q2 reported,
   * g = Q2 / Q1 − 1, Q3 = Q2 × (1 + g), Q4 = Q3 × (1 + g). The latest quarter is compared with the
   * one before (after Q1 only, last year's Q4). A line that is a loss (where a growth rate means
   * nothing) repeats its latest change in dollars instead. Flow statements only; each line is
   * projected on its own.
   */
  function addProjection(quarterly, annual) {
    const q = quarterly.periods, cur = q[0];
    if (!cur || !cur.q || cur.q > 3) return;
    const lastYear = annual.periods.find(p => p.fy === cur.fy - 1);
    if (!lastYear || annual.periods.some(p => p.fy === cur.fy)) return;
    const ix = new Map(q.map((p, i) => [p.fy + 'Q' + p.q, i]));
    const done = [], todo = [];
    for (let n = 1; n <= 4; n++) (n <= cur.q ? done : todo).push(n);
    const prevKey = cur.q > 1 ? cur.fy + 'Q' + (cur.q - 1) : (cur.fy - 1) + 'Q4'; // the quarter before the latest
    if (done.some(n => !ix.has(cur.fy + 'Q' + n)) || !ix.has(prevKey)) return;
    const end = new Date(Date.parse(lastYear.end) + 364 * 86400e3).toISOString().slice(0, 10);
    const later = k => calQuarter(new Date(Date.parse(cur.end) + 91 * k * 86400e3).toISOString().slice(0, 10));
    annual.periods.unshift({
      key: 'PROJ', label: String(calYear(end)), fy: cur.fy, end, months: 12,
      projected: { reported: done.map(n => q[ix.get(cur.fy + 'Q' + n)].label), projected: todo.map((_, k) => later(k + 1)), from: q[ix.get(prevKey)].label, to: cur.label },
    });
    for (const st of STATEMENTS) {
      const qRows = new Map(quarterly.statements[st.key].rows.map(r => [r.key, r]));
      for (const ar of annual.statements[st.key].rows) {
        let val = null;
        const qr = qRows.get(ar.key);
        if (st.kind === 'flow' && qr) {
          const now = done.map(n => qr.vals[ix.get(cur.fy + 'Q' + n)]);
          const last = qr.vals[0], prev = qr.vals[ix.get(prevKey)];
          if (now.every(x => x != null) && last != null && prev != null) {
            const projected = [];
            let x = last;
            for (let k = 0; k < todo.length; k++) {
              x = last > 0 && prev > 0 ? x * (last / prev) : x + (last - prev); // compounding growth; for a loss, the same change in dollars
              projected.push(x);
            }
            const sum = [...now, ...projected].reduce((a, b) => a + b, 0);
            val = round(ar.unit === SHARES ? sum / 4 : sum, ar.unit === PER_SHARE ? 4 : 3);
          }
        }
        ar.vals.unshift(val);
        if (ar.src) ar.src.unshift(val == null ? null : 'Projected: ' + done.length + ' reported quarter(s) + ' + todo.length + ' at the latest quarter-on-quarter growth');
      }
    }
  }

  function round(x, d) {
    const p = Math.pow(10, d);
    return Math.round(x * p) / p;
  }

  return { normalize, buildCalendar, ITEMS, STATEMENTS };
});
