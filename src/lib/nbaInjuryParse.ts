import { getDocumentProxy } from "unpdf";

// The official NBA injury report (a PDF published every 15 minutes: https://official.nba.com/nba-injury-report-2025-26-season/),
// parsed into one row per player per game. Pure parsing + URL building - no database - so it can be tested on its own.
//
// The PDF is a table: GameDate | GameTime | Matchup | Team | PlayerName | CurrentStatus | Reason. The game, time and team cells appear
// only on the first row they apply to, and a long reason wraps onto lines above AND below its player row, so the parse works on text
// positions: columns come from x, context carries down the page and across pages, and each reason line goes to the nearest player
// row. (Same algorithm as python/nba_model/injuries.py, which the tests were written against.)

export type InjuryRow = {
  game_date: string | null; // MM/DD/YYYY, Eastern
  game_time_et: string | null;
  matchup: string | null; // AWAY@HOME abbreviations
  team: string;
  player: string | null; // null on a team that has not submitted yet
  status: string; // Out | Doubtful | Questionable | Probable | Available | NOT YET SUBMITTED
  reason_cat: string | null;
  reason_detail: string | null;
};

const COLS: [string, number, number][] = [
  ["date", 0, 100],
  ["time", 100, 190],
  ["matchup", 190, 255],
  ["team", 255, 415],
  ["player", 415, 580],
  ["status", 580, 660],
  ["reason", 660, 9999],
];
const HEADER_TOKENS = new Set(["Game", "Date", "Time", "Matchup", "Team", "Player", "Name", "Current", "Status", "Reason", "GameDate", "GameTime", "PlayerName", "CurrentStatus"]);
const TIME_RE = /^\d{2}:\d{2}\(ET\)$/;
const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;
const MATCH_RE = /^[A-Z]{2,3}@[A-Z]{2,3}$/;
const STATUSES = new Set(["Out", "Doubtful", "Questionable", "Probable", "Available"]);

const col = (x: number): string => {
  for (const [name, lo, hi] of COLS) if (x >= lo && x < hi) return name;
  return "reason";
};
const camel = (s: string): string => s.replace(/(?<=[a-z])(?=[A-Z])/g, " ");
const teamName = (s: string): string => camel(s.replace(/^(LA)(?=[A-Z])/, "$1 ")).replace(/(?<=[a-z])(?=\d)/g, " ");
function playerName(s: string): string {
  const i = s.indexOf(",");
  let last = i >= 0 ? s.slice(0, i) : s;
  const first = i >= 0 ? s.slice(i + 1) : "";
  last = last.replace(/(Jr\.|Sr\.|II|III|IV)$/, " $1");
  return `${camel(first)} ${camel(last)}`.trim();
}

type Item = { str: string; x: number; y: number; w: number };

/** Report time for a URL: Eastern clock components of an instant, as the PDF file names use them. */
export function reportUrl(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: true }).formatToParts(at);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const ap = g("dayPeriod").toUpperCase().replace(/\./g, "");
  return `https://ak-static.cms.nba.com/referee/injury/Injury-Report_${g("year")}-${g("month")}-${g("day")}_${g("hour")}_${g("minute")}${ap}.pdf`;
}

export async function parseInjuryReport(buf: Uint8Array): Promise<InjuryRow[]> {
  const pdf = await getDocumentProxy(buf);
  const rows: InjuryRow[] = [];
  const ctx: { date: string | null; time: string | null; matchup: string | null; team: string | null } = { date: null, time: null, matchup: null, team: null };

  for (let pn = 1; pn <= pdf.numPages; pn++) {
    const page = await pdf.getPage(pn);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    let items: Item[] = (tc.items as { str?: string; transform: number[]; width?: number }[])
      .filter((i) => i.str && i.str.trim() !== "")
      .map((i) => ({ str: i.str as string, x: i.transform[4], y: vp.height - i.transform[5], w: i.width ?? 0 }));
    // title line at the top of every page, "Page 1 of 3" at the bottom, and the column header row (page 1 only)
    items = items.filter((i) => i.y > 80 && i.y < 530 && !(pn === 1 && i.y > 100 && i.y < 125 && HEADER_TOKENS.has(i.str.trim())));
    items.sort((a, b) => a.y - b.y || a.x - b.x);

    // visual rows
    const groups: Item[][] = [];
    for (const it of items) {
      const last = groups[groups.length - 1];
      if (last && Math.abs(it.y - last[0].y) <= 3) last.push(it);
      else groups.push([it]);
    }
    type Anchor = { date: string | null; time: string | null; matchup: string | null; team: string | null; y: number; playerRaw: string | null; status: string; reasons: { y: number; t: string }[] };
    const anchors: Anchor[] = [];
    const reasonLines: { y: number; t: string }[] = [];

    for (const g of groups) {
      const cells: Record<string, Item[]> = {};
      for (const it of g) (cells[col(it.x)] ??= []).push(it);
      const text = (c: string) => {
        const list = (cells[c] ?? []).sort((a, b) => a.x - b.x);
        let out = "";
        list.forEach((it, k) => {
          const prev = list[k - 1];
          out += prev && it.x - (prev.x + prev.w) > 2 ? ` ${it.str.trim()}` : it.str.trim();
        });
        return out;
      };
      const y = g[0].y;
      const date = text("date").replace(/\s+/g, "");
      const time = text("time").replace(/\s+/g, "");
      const matchup = text("matchup").replace(/\s+/g, "");
      if (DATE_RE.test(date)) ctx.date = date;
      if (TIME_RE.test(time)) ctx.time = time;
      if (MATCH_RE.test(matchup)) ctx.matchup = matchup;
      const team = text("team");
      if (team) ctx.team = team.replace(/\s+/g, "");
      const player = text("player");
      const status = text("status");
      const reason = text("reason");
      if (player.includes(",")) {
        anchors.push({ ...ctx, y, playerRaw: player.replace(/\s+/g, ""), status: STATUSES.has(status) ? status : status, reasons: [] });
        if (reason) reasonLines.push({ y, t: reason });
      } else if (reason.replace(/\s+/g, "").toUpperCase() === "NOTYETSUBMITTED" || player.replace(/\s+/g, "").toUpperCase() === "NOTYETSUBMITTED") {
        anchors.push({ ...ctx, y, playerRaw: null, status: "NOT YET SUBMITTED", reasons: [] });
      } else if (reason) {
        reasonLines.push({ y, t: reason });
      }
    }
    for (const r of reasonLines) {
      if (anchors.length === 0) continue;
      let best = anchors[0];
      for (const a of anchors) if (Math.abs(a.y - r.y) < Math.abs(best.y - r.y)) best = a;
      best.reasons.push(r);
    }
    for (const a of anchors) {
      const raw = a.reasons.sort((p, q) => p.y - q.y).map((r) => r.t).join(" ").trim();
      const dash = raw.indexOf("-");
      const cat = dash >= 0 ? raw.slice(0, dash) : raw;
      const detail = dash >= 0 ? raw.slice(dash + 1) : "";
      rows.push({
        game_date: a.date,
        game_time_et: a.time,
        matchup: a.matchup,
        team: teamName(a.team ?? ""),
        player: a.playerRaw ? playerName(a.playerRaw) : null,
        status: a.status,
        reason_cat: camel(cat).replace(/ \/ /g, "/").trim() || null,
        reason_detail: camel(detail).trim() || null,
      });
    }
  }
  return rows;
}

/** The newest report that exists, walking back from `now` in 15-minute steps (up to `hours` back). */
export async function fetchLatestReport(now = new Date(), hours = 6): Promise<{ rows: InjuryRow[]; reportTime: Date; url: string } | null> {
  const step = 15 * 60_000;
  let t = new Date(Math.floor(now.getTime() / step) * step);
  for (let k = 0; k < hours * 4; k++, t = new Date(t.getTime() - step)) {
    const url = reportUrl(t);
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36", Referer: "https://official.nba.com/" }, cache: "no-store" });
      if (!res.ok) continue;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf[0] !== 0x25) continue; // not a PDF
      return { rows: await parseInjuryReport(buf), reportTime: t, url };
    } catch {
      /* try the previous slot */
    }
  }
  return null;
}
