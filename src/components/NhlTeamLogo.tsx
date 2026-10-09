import Image from "next/image";
import { nhlLogoUrl } from "@/lib/nhlTeams";

/** An NHL team's logo from its full name or abbreviation; an empty circle if we don't recognise the team. */
export default function NhlTeamLogo({ team, size = 22 }: { team: string; size?: number }) {
  const src = nhlLogoUrl(team);
  if (!src) return <span className="inline-block shrink-0 rounded-full bg-surface-raised" style={{ width: size, height: size }} />;
  return <Image src={src} alt="" width={size} height={size} className="shrink-0 object-contain" style={{ width: size, height: size }} unoptimized />;
}
