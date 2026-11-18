/** 取小写扩展名(不含点);无扩展名返回空串。 */
export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

/** 路径末段(文件名)。 */
export function baseName(relPath: string): string {
  return relPath.split('/').pop() ?? relPath
}

/**
 * 路径的**目录段**(去掉文件名);根下的文件返回空串。
 *
 * 与 `baseName` 成对放在这里:`baseName` 是「取末段」,它是「取其余」—— 两处各写一份
 * `lastIndexOf('/')` 的话,改了一处另一处就漂(库内路径一律 `/` 分隔,与
 * `stored_file.rel_path` 同口径)。
 */
export function directoryOf(relPath: string): string {
  const i = relPath.lastIndexOf('/')
  return i < 0 ? '' : relPath.slice(0, i)
}

/**
 * 一份文件的**同目录兄弟名**集合。回填把扫到的全部文件喂进来一次即可。
 *
 * 键是目录(库内相对路径的目录段),值是该目录下**全部**文件名。
 */
export function siblingIndex(relPaths: Iterable<string>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>()
  for (const relPath of relPaths) {
    const dir = directoryOf(relPath)
    const name = baseName(relPath)
    const set = index.get(dir)
    if (set) set.add(name)
    else index.set(dir, new Set([name]))
  }
  return index
}
