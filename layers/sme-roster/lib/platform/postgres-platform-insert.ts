type StorageClass = 'null' | 'blob' | 'text' | 'integer' | 'real'
type ExactCell<Column extends string> =
  Record<Column, Buffer | null> & Record<`${Column}SqliteStorage`, StorageClass>

export function encodePlatformExactCell<Column extends string>(column: Column, value: string | number | Buffer | null): ExactCell<Column> {
  let bytes: Buffer | null
  let storage: StorageClass
  if (value === null) {
    bytes = null
    storage = 'null'
  } else if (Buffer.isBuffer(value)) {
    bytes = value
    storage = 'blob'
  } else if (typeof value === 'string') {
    bytes = Buffer.from(value)
    storage = 'text'
  } else {
    bytes = Buffer.alloc(8)
    storage = Number.isSafeInteger(value) ? 'integer' : 'real'
    if (storage === 'integer') bytes.writeBigInt64BE(BigInt(value))
    else bytes.writeDoubleBE(value)
  }
  return { [column]: bytes, [column + 'SqliteStorage']: storage } as ExactCell<Column>
}
