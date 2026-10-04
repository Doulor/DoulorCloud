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
}

function isMp3File(file: File): boolean {
  return file.type === "audio/mpeg" || /\.mp3$/i.test(file.name)
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

export default function AudioTagsTool() {
  const { t } = useT()
  const [file, setFile] = React.useState<File | null>(null)
  const [writable, setWritable] = React.useState(false)
  const [form, setForm] = React.useState<TagForm>(EMPTY_FORM)
  const [coverUrl, setCoverUrl] = React.useState<string | null>(null)
  const [coverBytes, setCoverBytes] = React.useState<ArrayBuffer | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [done, setDone] = React.useState(false)
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
    setWritable(false)
    clearCover()
  }, [clearCover])

  const setField =
    (key: keyof TagForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDone(false)
      setForm((f) => ({ ...f, [key]: e.target.value }))
    }

  const handleFiles = async (files: File[]) => {
    const f = files[0]
    if (!f) return
    resetAll()
    setBusy(true)
    try {
      const tags = await readTags(f)
      setFile(f)
      setWritable(isMp3File(f))
      setForm({
        title: tags.title ?? "",
        artist: tags.artist ?? "",
        album: tags.album ?? "",
        albumArtist: "",
        genre: tags.genre ?? "",
        year: tags.year ?? "",
        track: tags.track ?? "",
        comment: commentToString(tags.comment),
      })
      if (tags.picture?.data?.length) {
        const bytes = new Uint8Array(tags.picture.data)
        const blob = new Blob([bytes.buffer as ArrayBuffer], {
          type: tags.picture.format || "image/jpeg",
        })
        setCoverBytes(bytes.buffer as ArrayBuffer)
        setCoverUrl(URL.createObjectURL(blob))
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
      const buf = await readAsArrayBuffer(file)
      const writer = new ID3Writer(buf)
      // Strip the old tag first so edited fields don't duplicate.
      writer.removeTag()
      const v = (s: string) => s.trim()
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
                <p className="mt-2 text-xs text-muted-foreground">{t("at3.onlyMp3")}</p>
              )}
              {done && <p className="mt-2 text-xs text-muted-foreground">{t("at3.done")}</p>}
            </ToolSection>
          </div>
        )}
      </div>
      {busy && !file && (
        <p className="mt-2 text-sm text-muted-foreground">{t("at3.reading")}</p>
      )}
    </ToolShell>
  )
}
