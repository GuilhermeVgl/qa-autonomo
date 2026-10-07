const ROLE_PALETTE = ["#3c86ff", "#8b5cf6", "#06b6d4", "#10b981", "#f59e0b", "#ec4899", "#14b8a6"];

/** The color of a user, the same on the map and in the flows. */
export function roleColor(role: string | undefined): string {
  if (!role) return "transparent";
  let h = 0;
  for (const c of role) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ROLE_PALETTE[h % ROLE_PALETTE.length] as string;
}
