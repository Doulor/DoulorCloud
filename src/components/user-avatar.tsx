import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { cn } from "@/lib/utils"

export interface UserAvatarProps {
  username: string
  nickname?: string | null
  hasAvatar?: boolean
  className?: string
}

/** 头像渲染：有图显图，无图显昵称首字（无昵称回退用户名首字） */
export function UserAvatar({ username, nickname, hasAvatar, className }: UserAvatarProps) {
  const display = nickname || username
  const initial = display.slice(0, 1).toUpperCase()
  return (
    <Avatar className={cn("h-8 w-8", className)}>
      {hasAvatar ? (
        <AvatarImage src={`/u/${encodeURIComponent(username)}/avatar`} alt={display} />
      ) : null}
      <AvatarFallback>{initial}</AvatarFallback>
    </Avatar>
  )
}
