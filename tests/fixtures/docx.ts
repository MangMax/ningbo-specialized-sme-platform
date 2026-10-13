import { Document, Packer, Paragraph, Table, TableCell, TableRow } from 'docx'

export interface FixtureSection {
  attachment: string
  title: string
  rows: string[][]
}

/** 构造一份小型的「公布文件」docx 字节流,结构对齐真实文件(正文 + 附件段 + 表格)。 */
export async function buildAnnouncementDocx(sections: FixtureSection[]): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [new Paragraph({ text: '宁波市经济和信息化局文件' })]
  for (const s of sections) {
    children.push(new Paragraph({ text: s.attachment }))
    children.push(new Paragraph({ text: s.title }))
    children.push(
      new Table({
        rows: s.rows.map(
          (r) =>
            new TableRow({
              children: r.map((c) => new TableCell({ children: [new Paragraph({ text: c })] })),
            }),
        ),
      }),
    )
  }
  const doc = new Document({ sections: [{ children }] })
  return Packer.toBuffer(doc)
}
