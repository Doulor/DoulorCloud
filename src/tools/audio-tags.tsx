import * as React from "react"
import { Download, ImagePlus, Trash2 } from "lucide-react"
import jsmediatags from "jsmediatags"
import type { JsMediaTags } from "jsmediatags"
import { ID3Writer } from "browser-id3-writer"

import { FileDrop } from "@/components/toolbox/file-drop"
import { ToolShell, ToolSection } from "@/components/toolbox/tool-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { downloadBlob, formatBytes, readAsArrayBuffer } from "@/lib/toolbox/utils"
import {
  isFlacFile,
  readFlacTags,
  writeFlacTags,
} from "@/lib/audio/flac-tags"
import {
  formatLrcTime,
  lrcToText,
  lrcToTtml,
  parseLrc,
  textToLrc,
  ttmlToLrc,
} from "@/lib/audio/lyrics"
import { useT } from "@/i18n"

interface TagForm {
  title: string
  artist: string
  album: string
  albumArtist: string
  genre: string
  year: string
  track: string
  comment: string
  lyrics: string
}

const EMPTY_FORM: TagForm = {
  title: "",
  artist: "",
  album: "",
  albumArtist: "",
  genre: "",
  year: "",
  track: "",
  comment: "",
  lyrics: "",
}

type AudioFormat = "mp3" | "flac" | "other"

function detectFormat(file: File): AudioFormat {
  if (file.type === "audio/mpeg" || /\.mp3$/i.test(file.name)) return "mp3"
  if (isFlacFile(file)) return "flac"
  return "other"
}

function readTags(file: File): Promise<JsMediaTags> {
  return new Promise((resolve, reject) => {
    jsmediatags.read(file, {
      onSuccess: (tag) => resolve(tag.tags),
      onError: (err) => reject(new Error(err.info || err.type)),
    })
  })
}

function commentToString(comment: JsMediaTags["comment"]): string {
  if (!comment) return ""
  if (typeof comment === "string") return comment
  return comment.text ?? ""
}

function lyricsToString(lyrics: JsMediaTags["lyrics"]): string {
  if (!lyrics) return ""
  if (typeof lyrics === "string") return lyrics
  return lyrics.lyrics ?? ""
}

export default function AudioTagsTool() {
  const { t } = useT()
  const [file, setFile] = React.useState<File | null>(null)
  const [format, setFormat] = React.useState<AudioFormat>("other")
  const writable = format === "mp3" || format === "flac"
  const [form, setForm] = React.useState<TagForm>(EMPTY_FORM)
  const [coverUrl, setCoverUrl] = React.useState<string | null>(null)
  const [coverBytes, setCoverBytes] = React.useState<ArrayBuffer | null>(null)
  const [coverMime, setCoverMime] = React.useState("image/jpeg")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [done, setDone] = React.useState(false)
  const [previewLrc, setPreviewLrc] = React.useState(true)
  const coverInputRef = React.useRef<HTMLInputElement | null>(null)

  const clearCover = React.useCallback(() => {
    setCoverUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    setCoverBytes(null)
  }, [])

  const resetAll = React.useCallback(() => {
    setFile(null)
    setForm(EMPTY_FORM)
    setError(null)
    setDone(false)
    setFormat("other")
    setCoverMime("image/jpeg")
    clearCover()
  }, [clearCover])

  const setField =
    (key: keyof TagForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDone(false)
      setForm((f) => ({ ...f, [key]: e.target.value }))
    }

  const applyForm = (tags: {
    title?: string
    artist?: string
    album?: string
    albumArtist?: string
    genre?: string
    year?: string
    track?: string
    comment?: string
    lyrics?: string
  }) => {
    setForm({
      title: tags.title ?? "",
      artist: tags.artist ?? "",
      album: tags.album ?? "",
      albumArtist: tags.albumArtist ?? "",
      genre: tags.genre ?? "",
      year: tags.year ?? "",
      track: tags.track ?? "",
      comment: tags.comment ?? "",
      lyrics: tags.lyrics ?? "",
    })
  }

  const applyCover = (data: ArrayBuffer, mime: string) => {
    clearCover()
    setCoverBytes(data)
    setCoverMime(mime || "image/jpeg")
    setCoverUrl(URL.createObjectURL(new Blob([data], { type: mime || "image/jpeg" })))
  }

  const handleFiles = async (files: File[]) => {
    const f = files[0]
    if (!f) return
    resetAll()
    setBusy(true)
    try {
      const fmt = detectFormat(f)
      setFile(f)
      setFormat(fmt)
      if (fmt === "flac") {
        const { tags, cover } = await readFlacTags(f)
        applyForm(tags)
        if (cover) applyCover(cover.data, cover.mime)
      } else {
        const tags = await readTags(f)
        applyForm({
          title: tags.title,
          artist: tags.artist,
          album: tags.album,
          genre: tags.genre,
          year: tags.year,
          track: tags.track,
          comment: commentToString(tags.comment),
          lyrics: lyricsToString(tags.lyrics),
        })
        if (tags.picture?.data?.length) {
          const bytes = new Uint8Array(tags.picture.data)
          applyCover(bytes.buffer as ArrayBuffer, tags.picture.format || "image/jpeg")
        }
      }
    } catch {
      setError(t("at3.err.parse"))
    } finally {
      setBusy(false)
    }
  }

  const handleCoverPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ""
    if (!f) return
    try {
      const buf = await readAsArrayBuffer(f)
      clearCover()
      setCoverBytes(buf)
      setCoverMime(f.type || "image/jpeg")
      setCoverUrl(URL.createObjectURL(new Blob([buf], { type: f.type || "image/jpeg" })))
      setDone(false)
    } catch {
      setError(t("at3.err.cover"))
    }
  }

  const handleSave = async () => {
    if (!file || !writable) return
    setBusy(true)
    setError(null)
    try {
      const v = (s: string) => s.trim()
      if (format === "flac") {
        const cover = coverBytes ? { mime: coverMime, data: coverBytes } : null
        const out = await writeFlacTags(
          file,
          {
            title: v(form.title),
            artist: v(form.artist),
            album: v(form.album),
            albumArtist: v(form.albumArtist),
            genre: v(form.genre),
            year: v(form.year),
            track: v(form.track),
            comment: v(form.comment),
            lyrics: v(form.lyrics),
          },
          cover,
        )
        downloadBlob(new Blob([out], { type: "audio/flac" }), file.name)
        setDone(true)
        return
      }
      const buf = await readAsArrayBuffer(file)
      const writer = new ID3Writer(buf)
      // Strip the old tag first so edited fields don't duplicate.
      writer.removeTag()
      if (v(form.title)) writer.setFrame("TIT2", v(form.title))
      if (v(form.artist)) writer.setFrame("TPE1", [v(form.artist)])
      if (v(form.albumArtist)) writer.setFrame("TPE2", v(form.albumArtist))
      if (v(form.album)) writer.setFrame("TALB", v(form.album))
      if (v(form.genre)) writer.setFrame("TCON", [v(form.genre)])
      if (v(form.track)) writer.setFrame("TRCK", v(form.track))
      const yearNum = parseInt(v(form.year), 10)
      if (Number.isFinite(yearNum)) writer.setFrame("TYER", yearNum)
      if (v(form.comment))
        writer.setFrame("COMM", { language: "eng", description: "", text: v(form.comment) })
      if (v(form.lyrics))
        writer.setFrame("USLT", { language: "eng", description: "", lyrics: v(form.lyrics) })
      if (coverBytes)
        writer.setFrame("APIC", { type: 3, data: coverBytes, description: "" })
      writer.addTag()
      downloadBlob(writer.getBlob(), file.name)
      setDone(true)
    } catch {
      setError(t("at3.err.save"))
    } finally {
      setBusy(false)
    }
  }

  const lyricLines = React.useMemo(() => parseLrc(form.lyrics), [form.lyrics])

  const convertLyrics = (fn: (s: string) => string) => {
    setDone(false)
    setForm((f) => ({ ...f, lyrics: fn(f.lyrics) }))
  }

  const fields: { key: keyof TagForm; label: string; placeholder?: string }[] = [
    { key: "title", label: t("at3.title") },
    { key: "artist", label: t("at3.artist") },
    { key: "album", label: t("at3.album") },
    { key: "albumArtist", label: t("at3.albumArtist") },
    { key: "genre", label: t("at3.genre") },
    { key: "year", label: t("at3.year") },
    { key: "track", label: t("at3.track") },
  ]

  return (
    <ToolShell title={t("toolbox.audioTags.name")} description={t("at3.desc")}>
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <ToolSection title={t("at3.section.source")}>
            {!file ? (
              <FileDrop
                accept="audio/*"
                onFiles={(f) => void handleFiles(f)}
                hint={t("at3.pickHint")}
              />
            ) : (
              <div className="flex items-center justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatBytes(file.size)}
                    {!writable && ` · ${t("at3.readonly")}`}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={resetAll}>
                  {t("at3.replace")}
                </Button>
              </div>
            )}
            {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
          </ToolSection>

          {file && (
            <ToolSection title={t("at3.section.tags")}>
              <div className="grid gap-3 sm:grid-cols-2">
                {fields.map((f) => (
                  <div key={f.key} className="space-y-1.5">
                    <Label htmlFor={`at-${f.key}`}>{f.label}</Label>
                    <Input
                      id={`at-${f.key}`}
                      value={form[f.key]}
                      onChange={setField(f.key)}
                      disabled={!writable || busy}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-3 space-y-1.5">
                <Label htmlFor="at-comment">{t("at3.comment")}</Label>
                <Textarea
                  id="at-comment"
                  value={form.comment}
                  onChange={setField("comment")}
                  disabled={!writable || busy}
                  rows={3}
                />
              </div>
            </ToolSection>
          )}
        </div>

        {file && (
          <div className="space-y-4">
            <ToolSection title={t("at3.section.cover")}>
              {coverUrl ? (
                <img
                  src={coverUrl}
                  alt={t("at3.cover")}
                  className="aspect-square w-full rounded-lg border object-cover"
                />
              ) : (
                <div className="flex aspect-square w-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
                  {t("at3.noCover")}
                </div>
              )}
              {writable && (
                <div className="mt-3 flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => coverInputRef.current?.click()}
                    disabled={busy}
                  >
                    <ImagePlus className="mr-1.5 h-4 w-4" />
                    {t("at3.coverReplace")}
                  </Button>
                  {coverUrl && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        clearCover()
                        setDone(false)
                      }}
                      disabled={busy}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                  <input
                    ref={coverInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => void handleCoverPick(e)}
                  />
                </div>
              )}
            </ToolSection>

            <ToolSection title={t("at3.section.export")}>
              <Button onClick={() => void handleSave()} disabled={!writable || busy} className="w-full">
                <Download className="mr-1.5 h-4 w-4" />
                {busy ? t("at3.saving") : t("at3.save")}
              </Button>
              {!writable && (
                <p className="mt-2 text-xs text-muted-foreground">{t("at3.writeLimit")}</p>
              )}
              {done && <p className="mt-2 text-xs text-muted-foreground">{t("at3.done")}</p>}
            </ToolSection>
          </div>
        )}
      </div>

      {file && (
        <ToolSection title={t("at3.section.lyrics")}>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="at-lyrics">{t("at3.lyricsEdit")}</Label>
              <Textarea
                id="at-lyrics"
                value={form.lyrics}
                onChange={setField("lyrics")}
                disabled={!writable || busy}
                rows={12}
                className="font-mono text-xs leading-relaxed"
              />
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!writable || busy}
                  onClick={() => convertLyrics(lrcToText)}
                >
                  {t("at3.conv.lrc2text")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!writable || busy}
                  onClick={() => convertLyrics(textToLrc)}
                >
                  {t("at3.conv.text2lrc")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!writable || busy}
                  onClick={() => convertLyrics(lrcToTtml)}
                >
                  {t("at3.conv.lrc2ttml")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!writable || busy}
                  onClick={() => convertLyrics(ttmlToLrc)}
                >
                  {t("at3.conv.ttml2lrc")}
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>{t("at3.lyricsPreview")}</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPreviewLrc((p) => !p)}
                >
                  {previewLrc ? t("at3.lyricsRaw") : t("at3.lyricsParsed")}
                </Button>
              </div>
              <div className="max-h-80 overflow-y-auto rounded-lg border bg-muted/30 p-3">
                {lyricLines.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("at3.lyricsEmpty")}</p>
                ) : previewLrc ? (
                  <ol className="space-y-1.5">
                    {lyricLines.map((l, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm">
                        {l.time !== null && (
                          <span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                            {formatLrcTime(l.time).slice(1, -1)}
                          </span>
                        )}
                        <span className="whitespace-pre-wrap break-words">
                          {l.text || "　"}
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                    {form.lyrics}
                  </pre>
                )}
              </div>
            </div>
          </div>
        </ToolSection>
      )}

      {busy && !file && (
        <p className="mt-2 text-sm text-muted-foreground">{t("at3.reading")}</p>
      )}
    </ToolShell>
  )
}
