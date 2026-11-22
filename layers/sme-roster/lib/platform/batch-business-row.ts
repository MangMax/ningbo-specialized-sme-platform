// Keep provider business fields, including new scalar or structured fields.
// These keys carry transport copies or JavaScript object internals.
const excludedRowFields = new Set([
  'rawfields', 'rawdata', 'rawresponse', 'rawrequest', 'rawbody',
  'sourcetext', 'requestbody', 'responsebody', 'rawhtml', 'rawjson', '__proto__',
])

export function platformBatchBusinessRow<Cell>(row: Record<string, Cell>): Record<string, Cell> {
  return Object.fromEntries(Object.entries(row).filter(([key, value]) =>
    value !== null && value !== '' && !excludedRowFields.has(key.toLowerCase())))
}
