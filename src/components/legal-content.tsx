import * as React from "react"

import { useT } from "@/i18n"

/**
 * 法务文本的共享正文：服务条款（TermsContent）与隐私政策（PrivacyContent）。
 *
 * 弹窗（terms-dialog）与独立页面（pages/terms、pages/privacy）共用同一份正文，
 * 避免两处各自维护导致内容不同步。
 */

export function H({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-5 text-sm font-semibold text-foreground first:mt-0">{children}</h3>
}

export function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{children}</p>
}

export function Li({ children }: { children: React.ReactNode }) {
  return <li className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{children}</li>
}

export function TermsContent() {
  const { t } = useT()
  return (
    <>
      <P><LegalText text={t("lt.1")} /></P>
      <P><LegalText text={t("lt.2")} /></P>
      <P><LegalText text={t("lt.3")} /></P>

      <H><LegalText text={t("lt.4")} /></H>
      <P><LegalText text={t("lt.5")} /></P>
      <P><LegalText text={t("lt.6")} /></P>
      <P><LegalText text={t("lt.7")} /></P>
      <P><LegalText text={t("lt.8")} /></P>

      <H><LegalText text={t("lt.9")} /></H>
      <P><LegalText text={t("lt.10")} /></P>
      <P><LegalText text={t("lt.11")} /></P>
      <P><LegalText text={t("lt.12")} /></P>
      <P><LegalText text={t("lt.13")} /></P>

      <H><LegalText text={t("lt.14")} /></H>
      <P><LegalText text={t("lt.15")} /></P>
      <P><LegalText text={t("lt.16")} /></P>
      <P><LegalText text={t("lt.17")} /></P>
      <P><LegalText text={t("lt.18")} /></P>

      <H><LegalText text={t("lt.19")} /></H>
      <P><LegalText text={t("lt.20")} /></P>
      <ul className="mt-1 list-disc pl-5">
        <Li><LegalText text={t("lt.21")} /></Li>
        <Li><LegalText text={t("lt.22")} /></Li>
        <Li><LegalText text={t("lt.23")} /></Li>
        <Li><LegalText text={t("lt.24")} /></Li>
        <Li><LegalText text={t("lt.25")} /></Li>
        <Li><LegalText text={t("lt.26")} /></Li>
        <Li><LegalText text={t("lt.27")} /></Li>
        <Li><LegalText text={t("lt.28")} /></Li>
      </ul>
      <P><LegalText text={t("lt.29")} /></P>

      <H><LegalText text={t("lt.30")} /></H>
      <P><LegalText text={t("lt.31")} /></P>
      <P><LegalText text={t("lt.32")} /></P>
      <P><LegalText text={t("lt.33")} /></P>
      <P><LegalText text={t("lt.34")} /></P>
      <P><LegalText text={t("lt.35")} /></P>

      <H><LegalText text={t("lt.36")} /></H>
      <P><LegalText text={t("lt.37")} /></P>
      <P><LegalText text={t("lt.38")} /></P>
      <P><LegalText text={t("lt.39")} /></P>
      <P><LegalText text={t("lt.40")} /></P>

      <H><LegalText text={t("lt.41")} /></H>
      <P><LegalText text={t("lt.42")} /></P>
      <P><LegalText text={t("lt.43")} /></P>
      <P><LegalText text={t("lt.44")} /></P>
      <P><LegalText text={t("lt.45")} /></P>
      <P><LegalText text={t("lt.46")} /></P>

      <H><LegalText text={t("lt.47")} /></H>
      <P><LegalText text={t("lt.48")} /></P>
      <P><LegalText text={t("lt.49")} /></P>
      <P><LegalText text={t("lt.50")} /></P>
      <P><LegalText text={t("lt.51")} /></P>

      <H><LegalText text={t("lt.52")} /></H>
      <P><LegalText text={t("lt.53")} /></P>
      <P><LegalText text={t("lt.54")} /></P>
      <P><LegalText text={t("lt.55")} /></P>
      <P><LegalText text={t("lt.56")} /></P>

      <H><LegalText text={t("lt.57")} /></H>
      <P><LegalText text={t("lt.58")} /></P>
      <P><LegalText text={t("lt.59")} /></P>
      <P><LegalText text={t("lt.60")} /></P>

      <H><LegalText text={t("lt.61")} /></H>
      <P><LegalText text={t("lt.62")} /></P>
      <P><LegalText text={t("lt.63")} /></P>

      <H><LegalText text={t("lt.64")} /></H>
      <P><LegalText text={t("lt.65")} /></P>
      <P><LegalText text={t("lt.66")} /></P>
      <P><LegalText text={t("lt.67")} /></P>
      <P><LegalText text={t("lt.68")} /></P>
    </>
  )
}

export function PrivacyContent() {
  const { t } = useT()
  return (
    <>
      <P><LegalText text={t("lp.1")} /></P>

      <H><LegalText text={t("lp.2")} /></H>
      <P><LegalText text={t("lp.3")} /></P>
      <ul className="mt-1 list-disc pl-5">
        <Li><LegalText text={t("lp.4")} /></Li>
        <Li><LegalText text={t("lp.5")} /></Li>
        <Li><LegalText text={t("lp.6")} /></Li>
      </ul>

      <H><LegalText text={t("lp.7")} /></H>
      <P><LegalText text={t("lp.8")} /></P>
      <ul className="mt-1 list-disc pl-5">
        <Li><LegalText text={t("lp.9")} /></Li>
        <Li><LegalText text={t("lp.10")} /></Li>
        <Li><LegalText text={t("lp.11")} /></Li>
        <Li><LegalText text={t("lp.12")} /></Li>
      </ul>

      <H><LegalText text={t("lp.13")} /></H>
      <P><LegalText text={t("lp.14")} /></P>

      <H><LegalText text={t("lp.15")} /></H>
      <P><LegalText text={t("lp.16")} /></P>
      <ul className="mt-1 list-disc pl-5">
        <Li><LegalText text={t("lp.17")} /></Li>
        <Li><LegalText text={t("lp.18")} /></Li>
        <Li><LegalText text={t("lp.19")} /></Li>
        <Li><LegalText text={t("lp.20")} /></Li>
      </ul>

      <H><LegalText text={t("lp.21")} /></H>
      <P><LegalText text={t("lp.22")} /></P>

      <H><LegalText text={t("lp.23")} /></H>
      <P><LegalText text={t("lp.24")} /></P>
      <ul className="mt-1 list-disc pl-5">
        <Li><LegalText text={t("lp.25")} /></Li>
        <Li><LegalText text={t("lp.26")} /></Li>
        <Li><LegalText text={t("lp.27")} /></Li>
        <Li><LegalText text={t("lp.28")} /></Li>
      </ul>

      <H><LegalText text={t("lp.29")} /></H>
      <P><LegalText text={t("lp.30")} /></P>

      <H><LegalText text={t("lp.31")} /></H>
      <P><LegalText text={t("lp.32")} /></P>

      <H><LegalText text={t("lp.33")} /></H>
      <P><LegalText text={t("lp.34")} /></P>

      <H><LegalText text={t("lp.35")} /></H>
      <P><LegalText text={t("lp.36")} /></P>
    </>
  )
}

/**
 * 渲染法务文案里的轻量标记：`{b}…{/b}` → `<strong>`。
 *
 * 为什么用标记而不是 JSX：整份条款/政策是**一条一段词条**（`lt.N` / `lp.N`），
 * 中英各一份；若把粗体拆成独立词条，译者稍不留神就会拆错段落。用行内标记后
 * 一段一 key，翻译时能整段照顾语气，粗体位置由标记锁定。
 */
export function LegalText({ text }: { text: string }) {
  const parts = text.split(/\{b\}|\{\/b\}/)
  // split 后奇数下标即粗体段
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <strong key={i} className="text-foreground">
            {part}
          </strong>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  )
}
