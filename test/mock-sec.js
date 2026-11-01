// Tiny stand-in for SEC EDGAR, for running the app without internet.
//   node test/mock-sec.js            (listens on :4000)
//   SEC_DATA_BASE=http://127.0.0.1:4000 SEC_WWW_BASE=http://127.0.0.1:4000 SEC_USER_AGENT="Test test@example.com" node server.js
const http = require('http');
const { buildFixture } = require('./fixture');
const fixture = JSON.stringify(buildFixture());
const tickers = JSON.stringify({
  fields: ['cik', 'name', 'ticker', 'exchange'],
  data: [[1, 'Testco Industries Inc.', 'TEST', 'Nasdaq'], [1, 'Testco Industries Inc.', 'TEST-B', 'Nasdaq'], [2, 'No Data Fund', 'NODATA', 'NYSE']],
});
const port = +process.env.MOCK_PORT || 4000;
http.createServer((req, res) => {
  if (!/@/.test(req.headers['user-agent'] || '')) { res.writeHead(403); return res.end('Undeclared Automated Tool'); }
  if (req.url === '/files/company_tickers_exchange.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(tickers); }
  if (req.url === '/api/xbrl/companyfacts/CIK0000000001.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(fixture); }
  res.writeHead(404); res.end('Not found');
}).listen(port, '127.0.0.1', () => console.log('mock SEC on :' + port));
