import Image from "next/image";

/** A college team's logo from ESPN's CDN by team id (an empty circle when there is no id). */
export default function CbbLogo({ teamId, size = 22 }: { teamId: number | null | undefined; size?: number }) {
  if (!teamId) return <span className="inline-block shrink-0 rounded-full bg-surface-raised" style={{ width: size, height: size }} />;
  return (
    <Image
      src={`https://a.espncdn.com/i/teamlogos/ncaa/500/${teamId}.png`}
      alt=""
      width={size}
      height={size}
      className="shrink-0 object-contain"
      style={{ width: size, height: size }}
      unoptimized
    />
  );
}
