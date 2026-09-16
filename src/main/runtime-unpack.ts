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
 * 单条 pipeline 推进归档状态机；有界异步文件写入为解压流提供背压。
 * 缓存已创建目录，避免每个文件重复 mkdir，也不阻塞 Electron 主线程等待磁盘。
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createBrotliDecompress } from 'node:zlib'
import { dirname, join, resolve, sep } from 'node:path'

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
  private readonly directories = new Map<string, Promise<void>>()
  private readonly writes = new Set<Promise<void>>()
  private bufferedBytes = 0
  private writeError: Error | undefined
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
  async push(chunk: Buffer): Promise<void> {
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
        if (headerLength > 65536) throw new Error('runtime 归档头过大')
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
        if (typeof this.pending.path !== 'string' || !Number.isSafeInteger(this.pending.size) || this.pending.size < 0) {
          throw new Error('runtime 归档记录无效')
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
        await this.writeRecord(record, this.pieces.length === 1 ? this.pieces[0]! : Buffer.concat(this.pieces))
        this.pieces = []
        this.pending = undefined
        this.phase = 'length'
        continue
      }
    }
  }

  /** 当前记录的头长度（分块到达时暂存）。 */
  private headerLength: number | undefined

  /** 落盘一条记录。 */
  private async writeRecord(record: { path: string; size: number; mode: number }, content: Buffer): Promise<void> {
    const target = resolve(this.root, record.path)
    if (!target.startsWith(resolve(this.root) + sep)) throw new Error('runtime 归档路径越界')
    const directory = dirname(target)
    let created = this.directories.get(directory)
    if (created === undefined) {
      created = mkdir(directory, { recursive: true }).then(() => {})
      this.directories.set(directory, created)
    }
    this.bufferedBytes += content.length
    const task = created.then(() => writeFile(target, content, { mode: record.mode })).then(() => {
      this.files += 1
      this.bytes += content.length
    }).catch((error: unknown) => {
      this.writeError ??= error instanceof Error ? error : new Error(String(error))
    }).finally(() => {
      this.bufferedBytes -= content.length
    })
    this.writes.add(task)
    void task.then(() => this.writes.delete(task))
    // Bound both open files and buffered content; let disk writes overlap decompression.
    while (this.writes.size >= 16 || (this.bufferedBytes > 32 * 1024 * 1024 && this.writes.size > 0)) {
      await Promise.race(this.writes)
    }
    if (this.writeError !== undefined) throw this.writeError
    // 注意：这里**不**上报进度。解压后的字节数与归档大小不是同一量纲，用它算百分比
    // 会得到 400% 以上。进度由调用方按"已读取的归档字节"上报。
  }

  async drain(): Promise<void> {
    await Promise.all(this.writes)
    if (this.writeError !== undefined) throw this.writeError
  }
}

/** Content identity is written at build time; file timestamps change on installation. */
function archiveIdentity(archivePath: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(archivePath), 'runtime.json'), 'utf8')) as {
      format?: string; contentHash?: string; archiveBytes?: number
    }
    return manifest.format === 'dsh-runtime-archive' && manifest.archiveBytes === statSync(archivePath).size &&
      typeof manifest.contentHash === 'string' && /^[a-f0-9]{64}$/u.test(manifest.contentHash)
      ? manifest.contentHash : undefined
  } catch {
    return undefined
  }
}

/**
 * 判断已解包的运行时是否可直接复用。
 *
 * 新归档按构建时生成的内容摘要复用，不受安装器修改时间戳的影响。
 * 旧归档没有摘要时，保留大小与修改时间的兼容判断。
 * @param dir - 解包根目录。
 * @param archivePath - 当前归档路径。
 * @returns 可复用时返回解包根目录，否则 undefined。
 */
export function reusableUnpacked(dir: string, archivePath: string): string | undefined {
  const markerPath = join(dir, MARKER)
  if (!existsSync(markerPath)) return undefined
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { bytes?: number; mtimeMs?: number; contentHash?: string }
    const stats = statSync(archivePath)
    const identity = archiveIdentity(archivePath)
    if (identity !== undefined) {
      if (marker.contentHash !== identity) return undefined
    } else if (marker.bytes !== stats.size || marker.mtimeMs !== Math.round(stats.mtimeMs)) return undefined
    // 至少能看到 node 可执行文件，否则视为解包不完整。
    const hasNode =
      existsSync(join(dir, 'runtime', 'node', 'node.exe')) || existsSync(join(dir, 'runtime', 'node', 'bin', 'node'))
    const hasAnchor = existsSync(join(dir, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    return hasNode && hasAnchor ? dir : undefined
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
  await rm(dir, { recursive: true, force: true })
  const root = join(dir, 'runtime')
  await mkdir(root, { recursive: true })

  const reader = new ArchiveReader(root)
  const decompress = createBrotliDecompress({ chunkSize: 256 * 1024 })
  const contentHash = createHash('sha256')
  const identity = archiveIdentity(archivePath)

  // 进度按**已读取的归档字节**上报：这与归档总大小同一量纲，百分比因此必然落在 0-100。
  //
  // 踩过的坑：最初用"已写出的解压后字节数"除以归档总大小，界面显示到 444%
  // （197.6 MB 除以 42.9 MB）。两个量纲不同的数不能相比。
  let readBytes = 0
  try {
    const source = createReadStream(archivePath, { highWaterMark: 256 * 1024 })
    source.on('data', (chunk: Buffer | string) => {
      readBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
      onProgress?.(readBytes, archiveStats.size)
    })
    await pipeline(source, decompress, new Writable({
      write(chunk: Buffer, _encoding, callback) {
        contentHash.update(chunk)
        reader.push(chunk).then(() => callback(), callback)
      },
    }))
    await reader.drain()
    if (!reader.finished) throw new Error(`runtime 归档不完整（已解 ${reader.files} 个文件）`)
    const digest = contentHash.digest('hex')
    if (identity !== undefined && identity !== digest) throw new Error('runtime 归档内容校验失败')
    await writeFile(
      join(dir, MARKER),
      JSON.stringify({ bytes: archiveStats.size, mtimeMs: Math.round(archiveStats.mtimeMs), files: reader.files, contentHash: digest }, null, 2) + '\n',
    )
  } catch (error) {
    // Drain in-flight writes before deleting a failed extraction.
    await reader.drain().catch(() => {})
    // 解包失败就把半成品删掉，避免下次误判为"已解包可用"。
    await rm(dir, { recursive: true, force: true })
    throw error
  }

  return { dir, unpacked: true, files: reader.files }
}
