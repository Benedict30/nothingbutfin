// Accounting identities used to confirm the statements tie out.
//  - strict: must hold whenever every part is present (a failure means a wrong tag mapping)
//  - gap:    hold only when nothing is left out; differences come from lines the summary
//            doesn't show (minority interest; restricted cash and FX effects in cash flow)
const IDENTITIES = [
  { name: 'Gross profit = revenue − cost of revenue', kind: 'strict', parts: ['revenue', 'cogs', 'grossProfit'], diff: v => v.revenue - v.cogs - v.grossProfit, scale: v => v.revenue },
  { name: 'Operating income = gross profit − operating expenses', kind: 'strict', parts: ['grossProfit', 'opex', 'opIncome'], diff: v => v.grossProfit - v.opex - v.opIncome, scale: v => v.grossProfit },
  { name: 'Total assets = total liabilities & equity', kind: 'strict', parts: ['assets', 'liabEquity'], diff: v => v.assets - v.liabEquity, scale: v => v.assets },
  { name: 'Liabilities + equity = total liabilities & equity', kind: 'gap', note: 'minority interest not shown', parts: ['liabilities', 'equity', 'liabEquity'], diff: v => v.liabilities + v.equity - v.liabEquity, scale: v => v.liabEquity },
  { name: 'CFO + CFI + CFF = change in cash', kind: 'gap', note: 'restricted cash and FX effects not shown', parts: ['cfo', 'cfi', 'cff', 'cash', 'cashPrev'], diff: v => v.cfo + v.cfi + v.cff - (v.cash - v.cashPrev), scale: v => Math.max(Math.abs(v.cfo), Math.abs(v.cash)) },
];

/** Checks every period of a normalize() block; returns [{name, kind, note, checked, failed: [labels], failedKeys: [fiscal keys]}]. */
function checkBlock(block) {
  const vals = {};
  for (const st of Object.values(block.statements)) for (const r of st.rows) vals[r.key] = r.vals;
  return IDENTITIES.map(id => {
    const out = { name: id.name, kind: id.kind, note: id.note, checked: 0, failed: [], failedKeys: [] };
    block.periods.forEach((p, i) => {
      if (p.key === 'PROJ') return; // a projection: each line follows its own trend, so totals needn't add up
      const v = {};
      for (const k of id.parts) v[k] = k === 'cashPrev' ? (vals.cash || [])[i + 1] : (vals[k] || [])[i];
      if (id.parts.some(k => v[k] == null)) return;
      // a period-on-period change only makes sense between adjacent periods of equal length
      if (id.parts.includes('cashPrev') && (p.key === 'TTM' || block.periods[i + 1].months !== p.months)) return;
      out.checked++;
      // values are in millions: allow rounding (0.5) plus 0.5% of the line's size
      if (Math.abs(id.diff(v)) > 0.5 + Math.abs(id.scale(v)) * 0.005) { out.failed.push(p.label); out.failedKeys.push(p.key); }
    });
    return out;
  });
}

module.exports = { IDENTITIES, checkBlock };
