// Synthetic statement/confirmation text, in the line format
// src/adapter.mjs's parseStatementLines expects (one line per activity row,
// a "HOLDINGS" marker, then pipe-delimited position/balance/liability
// lines). This is the *extracted* text -- see fixtures/pdf.mjs for the
// generated-PDF bytes that wrap it for the extractor test.

export const STATEMENT_LINES = [
  "PAGE 1",
  "2025-01-08|Bought|EQUITY PURCHASE|WNDF|15|305.20|-4578.00|USD",
  "2025-01-15|Sold|EQUITY SALE|WNDF|25|212.844|5321.10|USD",
  "2025-01-22|Bought|TREASURY BILL PURCHASE<br/>RATE:4.500 DUE:2026-03-15|-|10000|98.75|-9875.00|USD",
  "PAGE 2",
  "2025-02-03|ACH Disbursement|AUTOMATED PAYMENT<br/>PAYEE:Example Utility Co<br/>ACCT:...4821|-|-|-|-150.00|USD",
  "2025-02-14|Dividend Received|QUARTERLY DIVIDEND|WNDF|-|-|42.17|USD",
  "HOLDINGS",
  "POSITION|2025-02-28|WNDF|Widget Neutral Diversified Fund|140|318.40|44576.00|41000.00|3576.00|USD|market_price|closing price on statement date",
  "POSITION|2025-02-28|-|Synthetic Cairn Private Fund, LP|-|-|-|-|-|USD|cost|no market for a privately held fund unit",
  "BALANCE|2025-02-28|58612.40|9036.40|USD|55210.00|58612.40",
  "LIABILITY|securities_based_line_of_credit|Example Securities-Based Line of Credit|-12500.00|USD|6.750|2025-02-28|collateralized by the brokerage account's marketable securities",
].join("\n");

// One row plus the FINRA Rule 2232 markup embedded in the description (v1
// does not add a schema field for it; see capabilities().quirks). No
// "HOLDINGS" section: a confirmation honestly declines holdings.
export const CONFIRMATION_LINES = [
  "PAGE 1",
  "2025-03-04|Bought|EQUITY TRADE CONFIRMATION<br/>MARKUP:12.50<br/>CUSIP:00000WNF1|WNDF|50|306.10|-15305.00|USD",
].join("\n");
