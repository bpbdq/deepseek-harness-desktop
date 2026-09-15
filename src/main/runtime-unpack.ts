/**
 * 内置运行时的按需解包。
 *
 * 安装包里携带的是**压缩后的运行时归档**（`resources/runtime.br`），而不是 27 400 个
 * 散文件。这样安装包与解包体积都小得多；代价是首次启动要把约 188 MB 解到用户目录，
 * 因此进度会显示在启动页上。
 *
 * 归档格式由 `scripts/compress-runtime.mjs` 生成：
 *   magic `DSHRT1\n` + 若干记录 + 结束哨兵（4 字节 0）
 *   每条记录 = 4 字节小端头长度 + JSON 头（path/size/mode）+ 文件内容
 * 自己定义格式是因为 Node 内置没有 tar 写入器，也不想为此加依赖。
 *
 * 解包位置很关键：**不能放在 `<userData>/runtime`**——那是运行时自动更新的地盘
 * （它在那里管理 `<版本>/` 目录与 `current` 联接）。放在旁边互不干扰。
 *
 * 实现上刻意用"同步状态机 + 异步喂数据"：解压流按块到达，状态机在块之间保留进度。
 * 早先写成"既 for-await 消费解压流、又把归档 pipeline 进去"是矛盾的，会死锁——
 * 这是本项目里最容易写错的一处，所以逻辑集中在一个地方、且可被单测覆盖。
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createBrotliDecompress } from 'node:zlib'
import { dirname, join } from 'node:path'

/** 归档的魔数，用于识别格式与版本。 */
const MAGIC = Buffer.from('DSHRT1\n', 'utf8')

/** 解包目录名（位于 userData 下，与自动更新的 `runtime/` 并列而非嵌套）。 */
export const UNPACKED_DIRNAME = 'bundled-runtime'

/** 记录解包结果的小文件，用来判断是否已经解过。 */
const MARKER = 'unpacked.json'

export interface UnpackResult {
  /** 解包后的运行时目录（其下是 `runtime/`）。 */
  dir: string
  /** 本次是否真的解包了（false 表示复用了上次结果）。 */
  unpacked: boolean
  /** 归档里的文件数，仅本次解包时有值。 */
  files?: number
}

/**
 * 解析归档字节流的状态机。
 *
 * 内容按"每个文件整体收齐再落盘"处理：归档里最大的单文件约 88 MB（node.exe），
 * 以内存换实现简单是划算的——流式写会引入跨块的文件句柄状态，是这类代码最容易出错的地方。
 */
class ArchiveReader {
  /** 未消费的字节。显式标注为 Buffer 以免被推断成 Buffer<ArrayBuffer>（与 slice 结果不兼容）。 */
  private buffer: Buffer = Buffer.alloc(0)
  /** 当前阶段。 */
  private phase: 'magic' | 'length' | 'header' | 'content' | 'done' = 'magic'
  /** 当前记录的头。 */
  private pending: { path: string; size: number; mode: number } | undefined
  /** 当前记录已收齐的内容块。 */
  private pieces: Buffer[] = []
  /** 当前记录已收字节数。 */
  private received = 0

  /** 已落盘的文件数。 */
  files = 0
  /** 已落盘的总字节数（解压后的原始大小）。 */
  bytes = 0

  constructor(
    private readonly root: string,
  ) {}

  /** 是否已经读到结束哨兵。 */
  get finished(): boolean {
    return this.phase === 'done'
  }

  /**
   * 喂入一块数据，尽可能多地推进解析。
   * @param chunk - 解压后的字节。
   */
  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])

    for (;;) {
      if (this.phase === 'done') return

      if (this.phase === 'magic') {
        if (this.buffer.length < MAGIC.length) return
        if (!this.buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
          throw new Error('runtime 归档格式不符：magic 不匹配')
        }
        this.buffer = this.buffer.subarray(MAGIC.length)
        this.phase = 'length'
        continue
      }

      if (this.phase === 'length') {
        if (this.buffer.length < 4) return
        const headerLength = this.buffer.readUInt32LE(0)
        this.buffer = this.buffer.subarray(4)
        if (headerLength === 0) {
          this.phase = 'done'
          return
        }
        this.headerLength = headerLength
        this.phase = 'header'
        continue
      }

      if (this.phase === 'header') {
        const need = this.headerLength ?? 0
        if (this.buffer.length < need) return
        this.pending = JSON.parse(this.buffer.subarray(0, need).toString('utf8')) as {
          path: string
          size: number
          mode: number
        }
        this.buffer = this.buffer.subarray(need)
        this.headerLength = undefined
        this.pieces = []
        this.received = 0
        this.phase = 'content'
        continue
      }

      if (this.phase === 'content') {
        const record = this.pending
        if (record === undefined) {
          this.phase = 'length'
          continue
        }
        const remaining = record.size - this.received
        if (remaining > 0) {
          if (this.buffer.length === 0) return
          const take = Math.min(remaining, this.buffer.length)
          this.pieces.push(this.buffer.subarray(0, take))
          this.buffer = this.buffer.subarray(take)
          this.received += take
          if (this.received < record.size) return
        }
        this.writeRecord(record, Buffer.concat(this.pieces))
        this.pending = undefined
        this.phase = 'length'
        continue
      }
    }
  }

  /** 当前记录的头长度（分块到达时暂存）。 */
  private headerLength: number | undefined

  /** 落盘一条记录。 */
  private writeRecord(record: { path: string; size: number; mode: number }, content: Buffer): void {
    const target = join(this.root, ...record.path.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, { mode: record.mode })
    this.files += 1
    this.bytes += content.length
    // 注意：这里**不**上报进度。解压后的字节数与归档大小不是同一量纲，用它算百分比
    // 会得到 400% 以上。进度由调用方按"已读取的归档字节"上报。
  }
}

/**
 * 判断已解包的运行时是否可直接复用。
 *
 * 依据标记文件里的归档大小与修改时间：归档换了（新版本安装包）就要重新解。只比大小
 * 不够——两个版本大小相同虽罕见但并非不可能。
 * @param dir - 解包根目录。
 * @param archivePath - 当前归档路径。
 * @returns 可复用时返回解包根目录，否则 undefined。
 */
export function reusableUnpacked(dir: string, archivePath: string): string | undefined {
  const markerPath = join(dir, MARKER)
  if (!existsSync(markerPath)) return undefined
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { bytes?: number; mtimeMs?: number }
    const stats = statSync(archivePath)
    if (marker.bytes !== stats.size || marker.mtimeMs !== Math.round(stats.mtimeMs)) return undefined
    // 至少能看到 node 可执行文件，否则视为解包不完整。
    const hasNode =
      existsSync(join(dir, 'runtime', 'node', 'node.exe')) || existsSync(join(dir, 'runtime', 'node', 'bin', 'node'))
    return hasNode ? dir : undefined
  } catch {
    return undefined
  }
}

/**
 * 把归档解包到用户目录；已解过且归档未变时直接复用。
 *
 * @param archivePath - `resources/runtime.br` 的绝对路径。
 * @param userDataDir - 应用数据目录（解包到其下的 `bundled-runtime/`）。
 * @param onProgress - 进度回调。参数是**已读取的归档字节数**与归档总大小，同一量纲，
 *   百分比因此必然在 0-100 之间。
 * @returns 解包结果。
 */
export async function ensureRuntimeUnpacked(
  archivePath: string,
  userDataDir: string,
  onProgress?: (readBytes: number, archiveBytes: number) => void,
): Promise<UnpackResult> {
  const dir = join(userDataDir, UNPACKED_DIRNAME)

  const reusable = reusableUnpacked(dir, archivePath)
  if (reusable !== undefined) return { dir, unpacked: false }

  const archiveStats = statSync(archivePath)
  // 重新解包前清干净，避免上一版残留混在里面。
  rmSync(dir, { recursive: true, force: true })
  const root = join(dir, 'runtime')
  mkdirSync(root, { recursive: true })

  const reader = new ArchiveReader(root)
  const decompress = createBrotliDecompress()

  // 进度按**已读取的归档字节**上报：这与归档总大小同一量纲，百分比因此必然落在 0-100。
  //
  // 踩过的坑：最初用"已写出的解压后字节数"除以归档总大小，界面显示到 444%
  // （197.6 MB 除以 42.9 MB）。两个量纲不同的数不能相比。
  let readBytes = 0
  await new Promise<void>((resolve, reject) => {
    const source = createReadStream(archivePath)
    source.on('error', reject)
    source.on('data', (chunk: Buffer | string) => {
      readBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
      onProgress?.(readBytes, archiveStats.size)
    })
    decompress.on('error', reject)
    decompress.on('data', (chunk: Buffer) => {
      try {
        reader.push(chunk)
      } catch (error) {
        decompress.destroy()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    decompress.on('end', () => {
      if (reader.finished) resolve()
      else reject(new Error(`runtime 归档不完整（已解 ${reader.files} 个文件）`))
    })
    source.pipe(decompress)
  }).catch((error: unknown) => {
    // 解包失败就把半成品删掉，避免下次误判为"已解包可用"。
    rmSync(dir, { recursive: true, force: true })
    throw error
  })

  writeFileSync(
    join(dir, MARKER),
    JSON.stringify({ bytes: archiveStats.size, mtimeMs: Math.round(archiveStats.mtimeMs), files: reader.files }, null, 2) + '\n',
  )

  return { dir, unpacked: true, files: reader.files }
}
