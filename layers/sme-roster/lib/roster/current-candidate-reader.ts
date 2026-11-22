/** Bound source rows and complete assessments to one disposable block. */
export function* currentCandidateIdBlocks(ids: Iterable<number>, size = 128): Generator<number[]> {
  let block: number[] = []
  for (const id of ids) {
    block.push(id)
    if (block.length === size) { yield block; block = [] }
  }
  if (block.length) yield block
}
