import { posix } from 'node:path'
import { Archive } from 'documonster/archive'
import { Xml, type XmlElement } from 'documonster/xml'

const localName = (name: string) => name.split(':').at(-1)

function resolvePart(source: string, target: string): string {
  const url = new URL(target, `https://xlsx.invalid/${source}`)
  if (url.origin !== 'https://xlsx.invalid' || url.search || url.hash) throw new Error('无效的 Excel 工作表关系')
  return decodeURIComponent(url.pathname.slice(1))
}

/** Inspect package metadata through public ZIP/XML APIs, never infer sheet parts
 * from sheetId, archive order, or the worksheets surviving the Excel reader.
 */
export async function inspectExcelSource(input: Uint8Array) {
  const archive = new Archive.ZipReader(input)
  const xml = async (part: string) => {
    const entry = await archive.get(part)
    if (!entry) throw new Error(`缺少 Excel 工作表或关系部件:${part}`)
    return Xml.parse(await entry.text()).root
  }
  const children = (root: XmlElement, name: string) => root.children.filter(
    (node): node is XmlElement => node.type === 'element' && localName(node.name) === name,
  )
  try {
    const packageRels = children(await xml('_rels/.rels'), 'Relationship')
    const office = packageRels.find(rel => rel.attributes.Type?.endsWith('/officeDocument'))
    if (!office?.attributes.Target || office.attributes.TargetMode === 'External') throw new Error('缺少 Excel 工作簿关系')
    const workbookPart = resolvePart('', office.attributes.Target)
    const workbook = await xml(workbookPart)
    const relationships = children(await xml(posix.join(posix.dirname(workbookPart), '_rels', `${posix.basename(workbookPart)}.rels`)), 'Relationship')
    const parts = new Map<string, string>()
    const sheets = children(workbook, 'sheets')[0]
    for (const sheet of sheets ? children(sheets, 'sheet') : []) {
      const id = Object.entries(sheet.attributes).find(([name]) => name.includes(':') && localName(name) === 'id')?.[1]
      const rel = relationships.find(item => item.attributes.Id === id)
      if (!rel?.attributes.Target || rel.attributes.TargetMode === 'External') throw new Error(`缺少 Excel 工作表关系:${sheet.attributes.name}`)
      // Workbook sheets also include chartsheets. Match worksheet relationship
      // kinds in both Transitional and Strict OOXML, as for officeDocument above.
      if (!rel.attributes.Type?.endsWith('/worksheet')) continue
      const part = resolvePart(workbookPart, rel.attributes.Target)
      if (!await archive.get(part)) throw new Error(`缺少 Excel 工作表部件:${part}`)
      parts.set(sheet.attributes.name!, part)
    }
    return parts
  } finally {
    await archive.close()
  }
}

// Documonster can reject an invalid typed date before the model-level date check.
export function rethrowExcelReadError(error: unknown, parts: Map<string, string>): never {
  if (error instanceof Error && error.cause instanceof Error && 'context' in error) {
    const cell = /^cell ([A-Z]+[0-9]+): <v>[\s\S]*<\/v> is not a date$/.exec(error.cause.message)
    const sheet = [...parts].find(([, part]) => part === error.context)
    if (cell && sheet) throw new Error(`无法读取 Excel 原始日期:${sheet[0]}!${cell[1]}`)
  }
  throw error
}

export function assertExcelSheets(parts: Map<string, string>, names: string[]) {
  if (parts.size !== names.length || [...parts.keys()].some((name, index) => name !== names[index])) {
    throw new Error('Excel 读取器未完整读取声明的工作表')
  }
}

/** Only native-date source metadata is needed here. The Excel model and even
 * its unstyled reader have already discarded the original offset/text.
 */
export async function readNativeDateSources(input: Uint8Array, part: string) {
  const archive = new Archive.ZipReader(input)
  const values = new Map<string, string>()
  try {
    const entry = await archive.get(part)
    if (!entry) throw new Error(`缺少 Excel 工作表部件:${part}`)
    const parser = new Xml.SaxParser()
    let address: string | undefined
    let inValue = false
    let value = ''
    parser.on('opentag', tag => {
      const name = localName(tag.name)
      if (name === 'c') {
        address = tag.attributes.t === 'd' ? tag.attributes.r : undefined
        value = ''
      } else if (name === 'v') inValue = true
    })
    const append = (text: string) => { if (address && inValue) value += text }
    parser.on('text', append)
    parser.on('cdata', append)
    parser.on('closetag', tag => {
      const name = localName(tag.name)
      if (name === 'v') inValue = false
      if (name === 'c') {
        if (address) values.set(address, value)
        address = undefined
      }
    })
    // Decoder preserves UTF-8 boundaries when ZIP extraction yields chunks.
    const decoder = new TextDecoder()
    for await (const chunk of entry.stream()) parser.write(decoder.decode(chunk, { stream: true }))
    parser.write(decoder.decode()).close()
    return values
  } finally {
    await archive.close()
  }
}
