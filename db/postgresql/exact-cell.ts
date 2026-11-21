export function decodePostgresExactCell(value: Buffer | null, storage: string | null): string | number | Buffer | null {
  if (value === null) return null
  switch (storage) {
    case 'text': return value.toString('utf8')
    case 'integer': return Number(value.readBigInt64BE())
    case 'real': return value.readDoubleBE()
    case 'blob': return value
    default: throw new Error('Invalid stored cell type')
  }
}
