// NHL team logos from ESPN's CDN (the "-dark" set is drawn for dark backgrounds). Our games table stores ESPN's
// team names ("Seattle Kraken") and the Teams table uses NHL abbreviations ("SEA"), so both resolve to ESPN's code.

const ESPN_CODE_BY_ABBREV: Record<string, string> = {
  ANA: "ana", ARI: "ari", BOS: "bos", BUF: "buf", CGY: "cgy", CAR: "car", CHI: "chi", COL: "col", CBJ: "cbj", DAL: "dal", DET: "det",
  EDM: "edm", FLA: "fla", LAK: "la", MIN: "min", MTL: "mtl", NSH: "nsh", NJD: "nj", NYI: "nyi", NYR: "nyr", OTT: "ott", PHI: "phi",
  PIT: "pit", SEA: "sea", SJS: "sj", STL: "stl", TBL: "tb", TOR: "tor", UTA: "utah", VAN: "van", VGK: "vgk", WSH: "wsh", WPG: "wpg",
};

// matched against the lower-cased, accent-stripped name; longer/more specific keys first
const ESPN_CODE_BY_NICKNAME: [string, string][] = [
  ["blue jackets", "cbj"], ["golden knights", "vgk"], ["maple leafs", "tor"], ["red wings", "det"], ["hockey club", "utah"], ["mammoth", "utah"],
  ["blackhawks", "chi"], ["hurricanes", "car"], ["avalanche", "col"], ["canadiens", "mtl"], ["lightning", "tb"], ["penguins", "pit"],
  ["predators", "nsh"], ["islanders", "nyi"], ["capitals", "wsh"], ["canucks", "van"], ["coyotes", "ari"], ["panthers", "fla"], ["senators", "ott"],
  ["oilers", "edm"], ["flames", "cgy"], ["flyers", "phi"], ["rangers", "nyr"], ["sabres", "buf"], ["bruins", "bos"], ["devils", "nj"], ["kraken", "sea"],
  ["sharks", "sj"], ["stars", "dal"], ["ducks", "ana"], ["kings", "la"], ["blues", "stl"], ["wild", "min"], ["jets", "wpg"],
];

/** ESPN's lower-case team code ("sea", "tb", "la"...) from a full name or NHL abbreviation; null if unknown. */
export function espnCode(team: string): string | null {
  const upper = team.trim().toUpperCase();
  if (ESPN_CODE_BY_ABBREV[upper]) return ESPN_CODE_BY_ABBREV[upper];
  const name = team.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return ESPN_CODE_BY_NICKNAME.find(([nick]) => name.includes(nick))?.[1] ?? null;
}

/** Logo URL (64px, for dark backgrounds) for an NHL team given its full name or NHL abbreviation; null if unknown. */
export function nhlLogoUrl(team: string | null | undefined): string | null {
  if (!team) return null;
  const code = espnCode(team);
  return code ? `https://a.espncdn.com/combiner/i?img=/i/teamlogos/nhl/500-dark/${code}.png&h=64&w=64` : null;
}
