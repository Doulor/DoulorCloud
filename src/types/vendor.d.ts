/**
 * 少数没有官方类型声明的第三方库，在这里补上最小可用的类型。
 */

declare module "gifenc" {
  export interface GifEncoderInstance {
    writeFrame(
      index: Uint8Array | number[],
      width: number,
      height: number,
      options?: {
        palette?: number[][]
        delay?: number
        transparent?: boolean
        transparentIndex?: number
        repeat?: number
        dispose?: number
        first?: boolean
      }
    ): void
    finish(): void
    bytes(): Uint8Array
    bytesView(): Uint8Array
    reset(): void
  }

  export function GIFEncoder(options?: {
    auto?: boolean
    initialCapacity?: number
  }): GifEncoderInstance

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: string; oneBitAlpha?: boolean; clearAlpha?: boolean }
  ): number[][]

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: string
  ): Uint8Array
}

declare module "jsmediatags" {
  export interface JsMediaTagsPicture {
    format: string
    type: string
    description: string
    data: number[]
  }

  export interface JsMediaTags {
    title?: string
    artist?: string
    album?: string
    year?: string
    comment?: string | { language: string; descriptor: string; text: string }
    track?: string
    genre?: string
    picture?: JsMediaTagsPicture
    lyrics?: string
  }

  export interface JsMediaTagResult {
    type: string
    version: string
    tags: JsMediaTags
  }

  export interface JsMediaCallbacks {
    onSuccess: (tag: JsMediaTagResult) => void
    onError: (error: { type: string; info: string }) => void
  }

  const jsmediatags: {
    read(file: Blob, callbacks: JsMediaCallbacks): void
  }
  export default jsmediatags
}
