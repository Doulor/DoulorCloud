/**
 * 最小 FLAC 标签读写（纯 TS，无依赖）。
 *
 * 只处理元数据块：保留 STREAMINFO 等原有块，重建 VORBIS_COMMENT（type 4）
 * 与 PICTURE（type 6），其余音频帧原样拼接。
 */

export interface FlacTags {
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  genre?: string
  year?: string
  track?: string
  comment?: string
  lyrics?: string
}

export interface FlacCover {
  mime: string
  data: ArrayBuffer
}

const VORBIS_COMMENT = 4
const PICTURE = 6

function readU24BE(view: DataView, offset: number): number {
  return (view.getUint8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2)
}

function writeU24BE(view: DataView, offset: number, value: number): void {
  view.setUint8(offset, (value >> 16) & 0xff)
  view.setUint8(offset + 1, (value >> 8) & 0xff)
  view.setUint8(offset + 2, value & 0xff)
}

interface MetaBlock {
  type: number
  data: Uint8Array
}

/** 解析 FLAC 元数据块，返回块列表与音频数据的起始偏移。 */
function parseBlocks(bytes: Uint8Array): { blocks: MetaBlock[]; audioOffset: number } {
  if (bytes.length < 4 || String.fromCharCode(...bytes.subarray(0, 4)) !== "fLaC") {
    throw new Error("not-flac")
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const blocks: MetaBlock[] = []
  let offset = 4
  for (;;) {
    if (offset + 4 > bytes.length) throw new Error("truncated")
    const header = view.getUint8(offset)
    const last = (header & 0x80) !== 0
    const type = header & 0x7f
    const length = readU24BE(view, offset + 1)
    const dataStart = offset + 4
    const dataEnd = dataStart + length
    if (dataEnd > bytes.length) throw new Error("truncated")
    blocks.push({ type, data: bytes.subarray(dataStart, dataEnd) })
    offset = dataEnd
    if (last) break
  }
  return { blocks, audioOffset: offset }
}

const textDecoder = new TextDecoder("utf-8")
const textEncoder = new TextEncoder()

function decodeCommentField(bytes: Uint8Array): [string, string] | null {
  const s = textDecoder.decode(bytes)
  const eq = s.indexOf("=")
  if (eq <= 0) return null
  return [s.slice(0, eq).toUpperCase(), s.slice(eq + 1)]
}

/** 从 VORBIS_COMMENT 块解析常用字段。 */
function parseVorbisComment(data: Uint8Array): FlacTags {
  const tags: FlacTags = {}
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 0
  const readStr = (): string => {
    const len = view.getUint32(offset, true)
    offset += 4
    const s = textDecoder.decode(data.subarray(offset, offset + len))
    offset += len
    return s
  }
  offset += 4 + view.getUint32(offset, true) // 跳过 vendor
  const count = view.getUint32(offset, true)
  offset += 4
  const pick = (obj: FlacTags, key: keyof FlacTags, value: string) => {
    if (!obj[key]) obj[key] = value
  }
  for (let i = 0; i < count; i++) {
    const field = decodeCommentField(textEncoder.encode(readStr()))
    if (!field) continue
    const [key, value] = field
    switch (key) {
      case "TITLE": pick(tags, "title", value); break
      case "ARTIST": pick(tags, "artist", value); break
      case "ALBUM": pick(tags, "album", value); break
      case "ALBUMARTIST": pick(tags, "albumArtist", value); break
      case "DATE": pick(tags, "year", value.slice(0, 4)); break
      case "TRACKNUMBER": pick(tags, "track", value.split("/")[0]); break
      case "GENRE": pick(tags, "genre", value); break
      case "DESCRIPTION": pick(tags, "comment", value); break
      case "COMMENT": if (!tags.comment) tags.comment = value; break
      case "LYRICS": pick(tags, "lyrics", value); break
    }
  }
  return tags
}

function parsePicture(data: Uint8Array): FlacCover | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 0
  const readBin = (): Uint8Array => {
    const len = view.getUint32(offset, false)
    offset += 4
    const b = data.subarray(offset, offset + len)
    offset += len
    return b
  }
  offset += 4 // picture type
  const mime = textDecoder.decode(readBin())
  readBin() // description
  offset += 16 // width, height, depth, colors
  const pic = readBin()
  const buf = new ArrayBuffer(pic.byteLength)
  new Uint8Array(buf).set(pic)
  return { mime, data: buf }
}

/** 读取 FLAC 文件的标签与封面。 */
export async function readFlacTags(file: File): Promise<{ tags: FlacTags; cover: FlacCover | null }> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const { blocks } = parseBlocks(bytes)
  let tags: FlacTags = {}
  let cover: FlacCover | null = null
  for (const b of blocks) {
    if (b.type === VORBIS_COMMENT && Object.keys(tags).length === 0) tags = parseVorbisComment(b.data)
    else if (b.type === PICTURE && !cover) cover = parsePicture(b.data)
  }
  return { tags, cover }
}

function encodeStr(s: string): Uint8Array {
  return textEncoder.encode(s)
}

function buildVorbisComment(tags: FlacTags): Uint8Array {
  const fields: Array<[string, string]> = []
  const put = (key: string, value?: string) => {
    const v = (value ?? "").trim()
    if (v) fields.push([key, v])
  }
  put("TITLE", tags.title)
  put("ARTIST", tags.artist)
  put("ALBUM", tags.album)
  put("ALBUMARTIST", tags.albumArtist)
  put("DATE", tags.year)
  put("TRACKNUMBER", tags.track)
  put("GENRE", tags.genre)
  put("DESCRIPTION", tags.comment)
  put("LYRICS", tags.lyrics)

  const vendor = encodeStr("DoulorCloud Audio Tag Editor")
  const parts: Uint8Array[] = []
  const pushU32LE = (n: number) => {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, n, true)
    parts.push(b)
  }
  pushU32LE(vendor.length)
  parts.push(vendor)
  pushU32LE(fields.length)
  for (const [k, v] of fields) {
    const entry = encodeStr(`${k}=${v}`)
    pushU32LE(entry.length)
    parts.push(entry)
  }
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

function buildPicture(cover: FlacCover): Uint8Array {
  const mime = encodeStr(cover.mime)
  const desc = encodeStr("")
  const data = new Uint8Array(cover.data)
  const total = 4 + 4 + mime.length + 4 + desc.length + 16 + 4 + data.length
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  let o = 0
  view.setUint32(o, 3, false); o += 4 // front cover
  view.setUint32(o, mime.length, false); o += 4
  out.set(mime, o); o += mime.length
  view.setUint32(o, desc.length, false); o += 4
  out.set(desc, o); o += desc.length
  o += 16 // width/height/depth/colors 留 0
  view.setUint32(o, data.length, false); o += 4
  out.set(data, o)
  return out
}

/** 把标签与封面写入 FLAC，返回新文件的 ArrayBuffer。
 *  cover 为 null 时移除原有封面（旧 PICTURE 块会被丢弃）。 */
export async function writeFlacTags(
  file: File,
  tags: FlacTags,
  cover: { mime: string; data: ArrayBuffer } | null,
): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const { blocks, audioOffset } = parseBlocks(bytes)

  const kept = blocks.filter((b) => b.type !== VORBIS_COMMENT && b.type !== PICTURE)
  const out: MetaBlock[] = [...kept, { type: VORBIS_COMMENT, data: buildVorbisComment(tags) }]
  if (cover) out.push({ type: PICTURE, data: buildPicture(cover) })

  let total = 4
  for (const b of out) total += 4 + b.data.length
  total += bytes.length - audioOffset

  const result = new Uint8Array(total)
  const view = new DataView(result.buffer)
  result.set([0x66, 0x4c, 0x61, 0x43]) // "fLaC"
  let o = 4
  out.forEach((b, i) => {
    const last = i === out.length - 1
    view.setUint8(o, (last ? 0x80 : 0x00) | b.type)
    writeU24BE(view, o + 1, b.data.length)
    result.set(b.data, o + 4)
    o += 4 + b.data.length
  })
  result.set(bytes.subarray(audioOffset), o)
  return result.buffer as ArrayBuffer
}

/** 简单判断是否为 FLAC（魔数 + 扩展名兜底）。 */
export function isFlacFile(file: File): boolean {
  return file.type === "audio/flac" ||
    file.type === "audio/x-flac" ||
    /\.flac$/i.test(file.name)
}
