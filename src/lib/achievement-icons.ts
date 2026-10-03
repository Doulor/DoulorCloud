import {
  Award,
  BadgeCheck,
  Calendar,
  CalendarCheck,
  Coins,
  Contact,
  Crown,
  Database,
  Eye,
  FileText,
  FolderOpen,
  Gift,
  Globe,
  HardDrive,
  Heart,
  Inbox,
  KeyRound,
  Layers,
  LogIn,
  Mail,
  MailCheck,
  Megaphone,
  MessageSquare,
  MessagesSquare,
  Network,
  Package,
  Palette,
  Plug,
  Route,
  Send,
  Share2,
  ShieldCheck,
  ShoppingBag,
  Smile,
  Sparkles,
  ThumbsUp,
  UserPlus,
} from "lucide-react"
import type * as React from "react"

/**
 * 后端 `icon` 标识 → lucide 图标。
 *
 * 抽到公共文件是因为**两处都要用**：成就页的勋章墙、个人空间的徽章墙。
 * 各写一份的话，后端新增成就时必然只改一处，另一处静默 fallback 成一个
 * 通用奖杯图标（不报错，只是图标全变成一样的，很难发现）。
 *
 * 后端新增成就时记得在这里补映射；没映射的会退化成 Award，不会崩。
 */
export const ACHIEVEMENT_ICONS: Record<string, React.ElementType> = {
  "hard-drive": HardDrive,
  sparkles: Sparkles,
  contact: Contact,
  globe: Globe,
  mail: Mail,
  network: Network,
  "log-in": LogIn,
  eye: Eye,
  inbox: Inbox,
  crown: Crown,
  calendar: Calendar,
  "badge-check": BadgeCheck,
  "folder-open": FolderOpen,
  database: Database,
  "key-round": KeyRound,
  send: Send,
  palette: Palette,
  package: Package,
  "file-text": FileText,
  "message-square": MessageSquare,
  heart: Heart,
  "thumbs-up": ThumbsUp,
  "messages-square": MessagesSquare,
  "user-plus": UserPlus,
  gift: Gift,
  layers: Layers,
  plug: Plug,
  route: Route,
  award: Award,
  // ---- 2026-10-03 新增 ----
  "shield-check": ShieldCheck,
  "mail-check": MailCheck,
  "calendar-check": CalendarCheck,
  coins: Coins,
  megaphone: Megaphone,
  "shopping-bag": ShoppingBag,
  "share-2": Share2,
  smile: Smile,
}

/** 取图标，未映射时回退通用奖杯 */
export function achievementIcon(icon: string): React.ElementType {
  return ACHIEVEMENT_ICONS[icon] ?? Award
}
