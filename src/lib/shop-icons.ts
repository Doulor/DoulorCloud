import {
  Activity,
  Archive,
  Atom,
  Award,
  BadgeCheck,
  BadgePercent,
  Banknote,
  Bell,
  Book,
  Bot,
  Box,
  Brain,
  Brush,
  Building,
  Cable,
  Calendar,
  Camera,
  Car,
  ChartLine,
  CircleDollarSign,
  CircuitBoard,
  ClipboardList,
  Clock,
  Cloud,
  CloudUpload,
  Code,
  Coffee,
  Coins,
  Compass,
  Cpu,
  CreditCard,
  Crown,
  CupSoda,
  Database,
  Download,
  FileText,
  Flag,
  Flame,
  FolderOpen,
  Gamepad2,
  Gauge,
  Gem,
  Gift,
  Globe,
  Handshake,
  HardDrive,
  Headphones,
  Headset,
  Heart,
  HeartHandshake,
  Hourglass,
  House,
  IdCard,
  Image,
  Infinity as InfinityIcon,
  KeyRound,
  Keyboard,
  Layers,
  Leaf,
  LifeBuoy,
  Lightbulb,
  Link,
  LockOpen,
  Mail,
  Map,
  Medal,
  Megaphone,
  MessageSquare,
  Mouse,
  Music,
  Network,
  Package,
  Palette,
  PartyPopper,
  PenTool,
  Percent,
  Phone,
  PiggyBank,
  Plane,
  Plug,
  Presentation,
  Receipt,
  Rocket,
  Route,
  Server,
  ServerCog,
  Settings,
  Share2,
  Shield,
  ShieldCheck,
  Shirt,
  ShoppingBag,
  ShoppingBasket,
  ShoppingCart,
  Smartphone,
  Sparkles,
  Star,
  Sticker,
  Store,
  Tag,
  Tags,
  Target,
  Terminal,
  ThumbsUp,
  Ticket,
  Timer,
  TrendingUp,
  Trophy,
  Upload,
  UserCheck,
  Users,
  Verified,
  Wallet,
  Watch,
  Wifi,
  Wrench,
  Zap,
} from "lucide-react"
import type * as React from "react"

/**
 * 积分商城的**内置图标库**。
 *
 * 站长上架商品时不用自己找图、找地方放 —— 直接从下面这些图标里挑一个，
 * 商品卡片上这个图标会占很大一块（见 points.tsx 的封面区）。
 *
 * 为什么把「可选项」和「映射表」放在同一个文件：
 * 管理端的图标选择器和用户端的商品卡片**都要用到同一份名单**。
 * 分开写的话，加图标时必然只改一处 —— 选择器里能选，卡片上却回退成默认图标，
 * 而且不报错、只是图标看起来不对，很难发现（achievement-icons.ts 踩过同一个坑）。
 *
 * 取值是 lucide 的 slug（小写连字符形式），和后端 `point_products.icon` 存的一致。
 * 后端只做格式校验、不做白名单：**未知名字在这里回退成默认图标**，
 * 所以加图标不必前后端同时改。
 */

export interface ShopIconDef {
  /** lucide slug，入库的就是这个值 */
  name: string
  Icon: React.ElementType
}

export interface ShopIconGroup {
  label: string
  icons: ShopIconDef[]
}

export const SHOP_ICON_GROUPS: ShopIconGroup[] = [
  {
    label: "充值 / 额度",
    icons: [
      { name: "coins", Icon: Coins },
      { name: "wallet", Icon: Wallet },
      { name: "credit-card", Icon: CreditCard },
      { name: "banknote", Icon: Banknote },
      { name: "circle-dollar-sign", Icon: CircleDollarSign },
      { name: "piggy-bank", Icon: PiggyBank },
      { name: "receipt", Icon: Receipt },
      { name: "gem", Icon: Gem },
      { name: "badge-percent", Icon: BadgePercent },
      { name: "percent", Icon: Percent },
      { name: "tag", Icon: Tag },
      { name: "tags", Icon: Tags },
      { name: "trending-up", Icon: TrendingUp },
      { name: "chart-line", Icon: ChartLine },
    ],
  },
  {
    label: "会员 / 权益",
    icons: [
      { name: "crown", Icon: Crown },
      { name: "star", Icon: Star },
      { name: "medal", Icon: Medal },
      { name: "trophy", Icon: Trophy },
      { name: "award", Icon: Award },
      { name: "badge-check", Icon: BadgeCheck },
      { name: "shield-check", Icon: ShieldCheck },
      { name: "shield", Icon: Shield },
      { name: "verified", Icon: Verified },
      { name: "ticket", Icon: Ticket },
      { name: "key-round", Icon: KeyRound },
      { name: "lock-open", Icon: LockOpen },
      { name: "id-card", Icon: IdCard },
      { name: "user-check", Icon: UserCheck },
      { name: "infinity", Icon: InfinityIcon },
    ],
  },
  {
    label: "AI / 技术",
    icons: [
      { name: "cpu", Icon: Cpu },
      { name: "bot", Icon: Bot },
      { name: "brain", Icon: Brain },
      { name: "server", Icon: Server },
      { name: "server-cog", Icon: ServerCog },
      { name: "cloud", Icon: Cloud },
      { name: "cloud-upload", Icon: CloudUpload },
      { name: "database", Icon: Database },
      { name: "terminal", Icon: Terminal },
      { name: "code", Icon: Code },
      { name: "network", Icon: Network },
      { name: "activity", Icon: Activity },
      { name: "rocket", Icon: Rocket },
      { name: "atom", Icon: Atom },
      { name: "circuit-board", Icon: CircuitBoard },
      { name: "cable", Icon: Cable },
      { name: "gauge", Icon: Gauge },
      { name: "sparkles", Icon: Sparkles },
      { name: "zap", Icon: Zap },
    ],
  },
  {
    label: "存储 / 网络",
    icons: [
      { name: "hard-drive", Icon: HardDrive },
      { name: "folder-open", Icon: FolderOpen },
      { name: "globe", Icon: Globe },
      { name: "route", Icon: Route },
      { name: "plug", Icon: Plug },
      { name: "wifi", Icon: Wifi },
      { name: "share-2", Icon: Share2 },
      { name: "link", Icon: Link },
      { name: "download", Icon: Download },
      { name: "upload", Icon: Upload },
      { name: "archive", Icon: Archive },
      { name: "box", Icon: Box },
      { name: "layers", Icon: Layers },
    ],
  },
  {
    label: "实物 / 周边",
    icons: [
      { name: "package", Icon: Package },
      { name: "gift", Icon: Gift },
      { name: "shopping-bag", Icon: ShoppingBag },
      { name: "shopping-cart", Icon: ShoppingCart },
      { name: "shopping-basket", Icon: ShoppingBasket },
      { name: "store", Icon: Store },
      { name: "shirt", Icon: Shirt },
      { name: "coffee", Icon: Coffee },
      { name: "cup-soda", Icon: CupSoda },
      { name: "headphones", Icon: Headphones },
      { name: "headset", Icon: Headset },
      { name: "keyboard", Icon: Keyboard },
      { name: "mouse", Icon: Mouse },
      { name: "smartphone", Icon: Smartphone },
      { name: "watch", Icon: Watch },
      { name: "book", Icon: Book },
      { name: "pen-tool", Icon: PenTool },
      { name: "sticker", Icon: Sticker },
      { name: "brush", Icon: Brush },
    ],
  },
  {
    label: "服务 / 支持",
    icons: [
      { name: "wrench", Icon: Wrench },
      { name: "settings", Icon: Settings },
      { name: "life-buoy", Icon: LifeBuoy },
      { name: "mail", Icon: Mail },
      { name: "message-square", Icon: MessageSquare },
      { name: "phone", Icon: Phone },
      { name: "calendar", Icon: Calendar },
      { name: "clock", Icon: Clock },
      { name: "file-text", Icon: FileText },
      { name: "clipboard-list", Icon: ClipboardList },
      { name: "users", Icon: Users },
      { name: "handshake", Icon: Handshake },
      { name: "heart-handshake", Icon: HeartHandshake },
      { name: "bell", Icon: Bell },
      { name: "megaphone", Icon: Megaphone },
    ],
  },
  {
    label: "娱乐 / 生活",
    icons: [
      { name: "heart", Icon: Heart },
      { name: "thumbs-up", Icon: ThumbsUp },
      { name: "flame", Icon: Flame },
      { name: "leaf", Icon: Leaf },
      { name: "palette", Icon: Palette },
      { name: "music", Icon: Music },
      { name: "camera", Icon: Camera },
      { name: "image", Icon: Image },
      { name: "gamepad-2", Icon: Gamepad2 },
      { name: "party-popper", Icon: PartyPopper },
      { name: "target", Icon: Target },
      { name: "compass", Icon: Compass },
      { name: "map", Icon: Map },
      { name: "plane", Icon: Plane },
      { name: "car", Icon: Car },
      { name: "house", Icon: House },
      { name: "building", Icon: Building },
      { name: "lightbulb", Icon: Lightbulb },
      { name: "flag", Icon: Flag },
      { name: "timer", Icon: Timer },
      { name: "hourglass", Icon: Hourglass },
      { name: "presentation", Icon: Presentation },
    ],
  },
]

/** slug → 组件。由分组表推导，避免两处名单不一致 */
const SHOP_ICON_MAP: Record<string, React.ElementType> = Object.fromEntries(
  SHOP_ICON_GROUPS.flatMap((g) => g.icons.map((i) => [i.name, i.Icon]))
)

/** 商品没选图标（也没填封面图）时的兜底图标 */
export const DEFAULT_SHOP_ICON: React.ElementType = Package

/**
 * 取图标组件。传 null / 未知名字都回退成默认图标 —— 不抛错、不留空。
 */
export function shopIcon(name: string | null | undefined): React.ElementType {
  if (!name) return DEFAULT_SHOP_ICON
  return SHOP_ICON_MAP[name] ?? DEFAULT_SHOP_ICON
}

/** 图标库总数量（管理端选择器上显示，纯展示用） */
export const SHOP_ICON_COUNT = SHOP_ICON_GROUPS.reduce((n, g) => n + g.icons.length, 0)
