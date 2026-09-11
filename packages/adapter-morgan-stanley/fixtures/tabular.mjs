// Synthetic download-control (tabular) export fixture. Header row uses the
// same real field names as the activity API, rendered as CSV
// column headers; invented values, quantity carried unsigned like the API's
// (see src/adapter.mjs resolveSignedQuantity, reused across both tiers).

export const TABULAR_EXPORT_CSV = [
  "ProcessDate,Activity,Description,Symbol,Quantity,Price,Amount,KeyAccount",
  "2025-01-08,Bought,EQUITY PURCHASE,WNDF,15,305.20,-4578.00,MS-ACCT-0001",
  "2025-01-15,Sold,EQUITY SALE,WNDF,25,212.844,5321.10,MS-ACCT-0001",
  "2025-01-22,Bought,TREASURY BILL PURCHASE,-,10000,98.75,-9875.00,MS-ACCT-0001",
  "2025-02-03,ACH Disbursement,AUTOMATED PAYMENT,-,-,-,-150.00,MS-ACCT-0001",
  "",
].join("\n");
