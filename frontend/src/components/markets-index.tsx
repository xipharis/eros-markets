"use client";

import Link from "next/link";
import { useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowDownRight, ArrowUpRight, Search, X } from "lucide-react";
import type { Address } from "viem";
import { marketOptions, useHead, type MarketSnapshot } from "@/lib/reads";
import { readSpot, type SpotSnapshot } from "@/lib/spot";
import { isSpotOnly, nativeBinding } from "@/config/native";
import type { MarketManifest } from "@/config/deployment";
import { useMarketList } from "@/lib/market-list";
import { fmtDuration, lotsToClaims, shortAddr, wadToUnit } from "@/lib/units";
import type { Tone } from "@/lib/enums";
import { chipFor } from "./market-parts";
import { Chip, Num, SectionRule, cx } from "./ui";
import { WarmingUp } from "./warming-up";

/** One question, traded as a perp, as Kuru YES/NO tokens, or both (same question text). */
type Question = { key: string; title: string; category?: string; perp?: MarketManifest; spot?: MarketManifest };
type Point = { t: number; v: number };

function groupQuestions(markets: MarketManifest[]): Question[] {
  const byTitle = new Map<string, Question>();
  for (const mk of markets) {
    const q = byTitle.get(mk.title) ?? { key: mk.engine, title: mk.title, category: mk.category };
    if (isSpotOnly(mk.engine)) q.spot ??= mk; else q.perp ??= mk;
    byTitle.set(mk.title, q);
  }
  return [...byTitle.values()];
}

// Same query key as useSpot(engine, undefined, block), so the market page reuses this read.
const spotOptions = (engine: Address, block: bigint | undefined) => ({
  queryKey: ["spot", engine.toLowerCase(), undefined] as const,
  enabled: !!nativeBinding(engine) && block !== undefined,
  queryFn: () => readSpot(engine, undefined, block!),
  refetchInterval: 8000,
});

/** Everything a card shows, derived from live reads only. */
function summarize(q: Question, perp: MarketSnapshot | undefined, spot: SpotSnapshot | undefined, now: bigint | undefined) {
  const yesBid = spot?.books.yes.bids[0]?.tick, yesAsk = spot?.books.yes.asks[0]?.tick;
  const spotMid = yesBid !== undefined && yesAsk !== undefined ? (yesBid + yesAsk) / 2000 : undefined;
  const odds = perp?.risk.indexAvailable ? { p: wadToUnit(perp.risk.indexWad), source: "Index" }
    : perp?.risk.markAvailable ? { p: wadToUnit(perp.risk.markWad), source: "Mark" }
    : spotMid !== undefined ? { p: spotMid, source: "Kuru mid" } : undefined;
  const raw: { label: string; tone: Tone } | undefined = perp ? chipFor(perp)
    : spot ? (spot.resolved ? { label: "Resolved", tone: "muted" } : spot.issuanceOpen ? { label: "Trading", tone: "neutral" } : { label: "Halted", tone: "warn" })
    : undefined;
  // Live reads in Signal; paused, waiting and settled states step back so the two read apart at a glance.
  const chip = raw && (raw.label === "Trading" ? { ...raw, tone: "signal" as Tone } : raw.tone === "signal" ? raw : { ...raw, tone: "muted" as Tone });
  // Both sides of a quote come from one venue, named.
  const quote = perp && (perp.bestBid || perp.bestAsk) ? { bid: perp.bestBid, ask: perp.bestAsk, venue: "Perp" }
    : yesBid || yesAsk ? { bid: yesBid, ask: yesAsk, venue: "Kuru" } : undefined;
  const scheduledT = perp?.listing.scheduledT ?? (q.spot ? BigInt(nativeBinding(q.spot.engine)!.scheduledT) : undefined);
  const caps = perp ? (perp.leverageCaps.long > perp.leverageCaps.short ? perp.leverageCaps.long : perp.leverageCaps.short) : undefined;
  const trading = chip?.label === "Trading";
  const closed = !!perp?.halted || !!spot?.resolved;
  return {
    odds, chip, trading,
    quote,
    toT: scheduledT !== undefined && now !== undefined ? scheduledT - now : undefined,
    oi: perp?.oiLots, capX: perp ? Number(perp.listing.deploymentCapX) : undefined,
    leverage: perp ? `${caps}× now · ${perp.listing.deploymentCapX}× max` : undefined,
    rank: closed ? 3 : trading ? 0 : chip ? 1 : 2,
  };
}
type Summary = ReturnType<typeof summarize>;

/** The last 24h of published index prices (perp), or of Kuru YES fills (spot only). */
function useTrace(q: Question) {
  const engine = (q.perp ?? q.spot)?.engine;
  return useQuery({
    queryKey: ["question-trace", engine?.toLowerCase()],
    enabled: !!engine,
    refetchInterval: 60_000,
    queryFn: async ({ signal }): Promise<Point[]> => {
      if (q.perp) {
        const r = await fetch(`/api/price-history/${q.perp.engine}`, { signal, cache: "no-store" });
        if (!r.ok) throw new Error("History unavailable");
        const body = await r.json() as { prices: { kind: string; payload: string }[] };
        return body.prices.filter((e) => e.kind === "ObservationAccepted").map((e) => JSON.parse(e.payload))
          .filter((p) => p.depthValid === true).map((p) => ({ t: Number(p.observedAt), v: Number(BigInt(p.priceWad) / 10n ** 12n) / 1e6 }))
          .sort((a, b) => a.t - b.t);
      }
      const r = await fetch(`/api/kuru-trades/${q.spot!.engine}`, { signal, cache: "no-store" });
      if (!r.ok) throw new Error("Trades unavailable");
      const body = await r.json() as { trades: { outcome: string; timestamp: number; tick: number }[] };
      return body.trades.filter((t) => t.outcome === "yes").map((t) => ({ t: t.timestamp, v: t.tick / 1000 })).sort((a, b) => a.t - b.t);
    },
  });
}

const pct = (p: number) => (p * 100).toFixed(1);
const price = (tick?: number) => tick ? (tick / 1000).toFixed(3) : "—";

/** A real 24h price line: Signal stroke, its low and high labelled, drawn in once. */
function PriceTrace({ points }: { points: Point[] }) {
  const W = 240, H = 72;
  const lo = Math.min(...points.map((p) => p.v)), hi = Math.max(...points.map((p) => p.v));
  const flat = hi - lo < 0.0005, span = hi - lo, t0 = points[0].t, t1 = points.at(-1)!.t;
  const y = (v: number) => flat ? H / 2 : H - 6 - ((v - lo) / span) * (H - 12);
  const d = points.map((p, i) => `${i ? "L" : "M"}${(((p.t - t0) / Math.max(t1 - t0, 1)) * W).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  return <figure className="flex min-w-0 flex-1 gap-2" aria-label={flat ? `YES price flat at ${pct(lo)}% over the last 24 hours` : `YES price over the last 24 hours, between ${pct(lo)}% and ${pct(hi)}%`}>
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="trace-draw h-[72px] w-full min-w-0 overflow-visible" aria-hidden>
      <line x1="0" x2={W} y1="6" y2="6" className="stroke-line" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
      <line x1="0" x2={W} y1={H - 6} y2={H - 6} className="stroke-line" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
      <path d={d} fill="none" className="stroke-signal" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
    <figcaption className="flex shrink-0 flex-col justify-between py-0.5 text-right text-2xs tnum text-fg-3" aria-hidden>
      {flat ? <><span /><span>flat · 24h</span><span /></> : <><span>{pct(hi)}</span><span>24h</span><span>{pct(lo)}</span></>}
    </figcaption>
  </figure>;
}

function QuestionCard({ q, s }: { q: Question; s: Summary }) {
  const trace = useTrace(q);
  const points = trace.data && trace.data.length > 1 ? trace.data : undefined;
  const move = points ? (points.at(-1)!.v - points[0].v) * 100 : undefined;
  // No live price: the last published index of the past 24h, labelled as such, with the warming notice.
  const odds = s.odds ?? (points ? { p: points.at(-1)!.v, source: "Last published" } : undefined);
  return <li className="frame flex min-w-0 flex-col bg-ground">
    <div className="label flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2 text-fg-3 shadow-[inset_0_-1px_0_var(--color-line-strong)]">
      <span className="flex items-center gap-2">
        {s.trading && <span className="warming-pulse h-2 w-2 rounded-sm bg-signal" aria-hidden />}
        {q.category ?? "Event"}
        {s.chip && <Chip tone={s.chip.tone}>{s.chip.label}</Chip>}
      </span>
    </div>

    <div className="flex flex-1 flex-col gap-5 p-4 sm:p-5">
      <div className="flex flex-col gap-2">
        <h3 className="text-xl font-semibold leading-snug tracking-[-0.02em] text-balance text-fg sm:text-2xl">{q.title}</h3>
        {s.toT !== undefined && <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="label text-fg-3">{s.toT > 0n ? "Resolves in" : "Resolution"}</span>
          {s.toT > 0n ? <Num value={fmtDuration(s.toT)} className="font-semibold text-fg" /> : <span className="font-semibold text-fg">past its scheduled time</span>}
        </p>}
      </div>
      {odds ? <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:gap-6">
        <div className="shrink-0">
          <p className="flex items-baseline gap-1 leading-none text-fg">
            <Num value={pct(odds.p)} className="text-[clamp(2.5rem,5.5vw,3.5rem)] font-semibold tracking-[-0.04em]" />
            <span className="text-xl font-semibold text-fg-2">%</span>
          </p>
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
            <span className="label text-fg">Yes</span>
            <span>{odds.source}</span>
            {move !== undefined && (Math.abs(move) < 0.05 ? <span className="tnum">unchanged · 24h</span>
              : <span className="inline-flex items-center gap-0.5 tnum text-fg-2">
                {move > 0 ? <ArrowUpRight size={13} aria-hidden /> : <ArrowDownRight size={13} aria-hidden />}
                {move > 0 ? "+" : ""}{move.toFixed(1)} pp · 24h
              </span>)}
          </p>
        </div>
        {points ? <PriceTrace points={points} />
          : <p className="flex h-[72px] flex-1 items-center text-xs text-fg-3">{trace.isError ? "Price history unavailable" : trace.isPending ? "Loading 24h history…" : "No price history in the last 24h"}</p>}
      </div> : <div className="flex flex-col gap-2 py-1">
        <p className="flex items-center gap-3">
          <span className="h-4 w-4 shrink-0 shadow-[inset_0_0_0_1.5px_var(--color-signal)]" aria-hidden />
          <span className="text-2xl font-semibold tracking-[-0.02em] text-fg">No live price</span>
        </p>
        <p className="text-xs leading-relaxed text-fg-3">{s.chip && !s.trading ? `${s.chip.label}. The odds return once the market publishes its index again.` : "Waiting for the first published price."}</p>
      </div>}
      {!s.odds && <WarmingUp compact className="items-start text-left" />}

      <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-md bg-line text-xs sm:grid-cols-3">
        {([
          [s.quote ? `Bid / ask · ${s.quote.venue}` : "Bid / ask", s.quote ? `${price(s.quote.bid)} / ${price(s.quote.ask)}` : "No quotes"],
          ["Open interest", q.perp ? (s.oi !== undefined ? `${lotsToClaims(s.oi)} claims` : "—") : "Spot only"],
          ["Leverage", q.perp ? (s.leverage ?? "—") : "1× · fully backed"],
        ] as const).map(([k, v]) => <div key={k} className="flex min-w-0 items-baseline justify-between gap-3 bg-panel px-3 py-2.5 sm:block">
          <dt className="label text-fg-3">{k}</dt>
          <dd className="tnum text-fg sm:mt-1">{v}</dd>
        </div>)}
      </dl>
    </div>

    <div className="grid gap-px border-t border-line-strong bg-line sm:auto-cols-fr sm:grid-flow-col">
      {q.perp && (s.trading ? <Link href={`/m/${q.perp.engine}`} className="group flex min-h-14 items-stretch bg-ground">
        <span className="ui-arrow flex w-12 shrink-0 items-center justify-center bg-signal text-on-signal" aria-hidden><ArrowRight size={15} strokeWidth={2} /></span>
        <span className="ui-sweep flex flex-1 flex-col justify-center bg-action px-4 py-2 text-on-action group-hover:bg-action-hover">
          <span className="label">Trade with leverage</span>
          <span className="text-2xs opacity-70">Long or short{s.capX ? ` · up to ${s.capX}×` : ""}</span>
        </span>
      </Link> : <SecondaryAction href={`/m/${q.perp.engine}`} label="Open perp market" note={s.chip ? `Trading paused · ${s.chip.label.replace(/^Paused: /, "")}` : "Reading market state…"} />)}
      {q.spot && <SecondaryAction href={`/m/${q.spot.engine}`} label="Buy YES / NO tokens" note="Kuru spot · fully backed" />}
    </div>
  </li>;
}

function SecondaryAction({ href, label, note }: { href: string; label: string; note: string }) {
  return <Link href={href} className="group flex min-h-14 items-center justify-between gap-3 bg-panel px-4 py-2 transition-colors hover:bg-hover">
    <span className="flex flex-col">
      <span className="label text-fg">{label}</span>
      <span className="text-2xs text-fg-3">{note}</span>
    </span>
    <ArrowRight size={15} className="shrink-0 text-fg-2 transition-transform group-hover:translate-x-0.5 group-hover:text-fg" aria-hidden />
  </Link>;
}

/** What sets an archived deployment apart: its metadata note (e.g. "1x perp, retired", "resolved YES"), else its venue. */
function deploymentLabel(mk: MarketManifest) {
  const note = mk.short.match(/\(([^)]+)\)\s*$/)?.[1];
  if (note) return note.charAt(0).toUpperCase() + note.slice(1);
  return isSpotOnly(mk.engine) ? "Kuru spot" : nativeBinding(mk.engine) ? "Native market" : "Perp";
}

/** Archived deployments of one question, each named by what differs, with its contract for reference. */
function ClosedQuestion({ title, items }: { title: string; items: MarketManifest[] }) {
  return <li className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
    <span className="min-w-0 text-sm text-fg-2">{title}</span>
    <span className="flex flex-wrap gap-x-5">
      {items.map((mk) => <Link key={mk.engine} href={`/m/${mk.engine}`} aria-label={`Open ${title}: ${deploymentLabel(mk)}, contract ${mk.engine}`}
        className="group inline-flex min-h-11 items-center gap-2 text-xs text-fg-2 hover:text-fg">
        <span className="font-medium">{deploymentLabel(mk)}</span>
        <span className="tnum text-fg-4 group-hover:text-fg-3">{shortAddr(mk.engine)}</span>
        <ArrowRight size={13} aria-hidden />
      </Link>)}
    </span>
  </li>;
}

export function MarketsIndex() {
  const head = useHead();
  const block = head.data?.number, now = head.data?.timestamp;
  const discovery = useMarketList();
  const listed = useMemo(() => discovery.markets.filter((market) => !market.archived), [discovery.markets]);
  const archived = discovery.markets.filter((market) => market.archived);
  const search = useSearchParams().get("q") ?? "";
  const setSearch = (value: string) => {
    const url = new URL(window.location.href);
    if (value) url.searchParams.set("q", value); else url.searchParams.delete("q");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  };
  const searchInput = useRef<HTMLInputElement>(null);
  const normalize = (value: string) => value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase();
  const terms = normalize(search).trim().split(/\s+/).filter(Boolean);
  const matches = (mk: MarketManifest) => terms.every((term) => normalize([mk.title, mk.short, mk.category, mk.source].filter(Boolean).join(" ")).includes(term));
  const questions = useMemo(() => groupQuestions(listed), [listed]);

  // The board ranks by live state, so it reads every listed market up front (shared with the market pages).
  const perpReads = useQueries({ queries: questions.map((q) => marketOptions((q.perp?.engine ?? q.key) as Address, q.perp ? block : undefined)) });
  const spotReads = useQueries({ queries: questions.map((q) => spotOptions((q.spot?.engine ?? q.key) as Address, q.spot ? block : undefined)) });
  const summaries = new Map(questions.map((q, i) => [q.key, summarize(q,
    q.perp ? perpReads[i].data as MarketSnapshot | undefined : undefined, q.spot ? spotReads[i].data : undefined, now)]));
  const board = questions.filter((q) => [q.perp, q.spot].some((mk) => mk && matches(mk))).sort((a, b) => {
    const x = summaries.get(a.key)!, y = summaries.get(b.key)!;
    return x.rank - y.rank || Number((x.toT ?? 0n) - (y.toT ?? 0n));
  });
  const closed = archived.filter(matches);
  const tradingCount = questions.filter((q) => summaries.get(q.key)?.trading).length;
  const clearSearch = () => { setSearch(""); searchInput.current?.focus(); };

  return (
    <main className="mx-auto w-full max-w-[1280px] px-4 pt-10 pb-16 md:px-8">
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
        <div className="max-w-2xl">
          <h1 className="display text-5xl leading-none text-fg uppercase">Markets</h1>
          <p className="mt-3 text-sm leading-relaxed text-fg-2">
            Every market is a YES/NO question with a scheduled answer. Take a leveraged long or short on the odds, or buy YES and NO tokens outright. One claim pays 1 if the answer is YES.
          </p>
          <p className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tnum text-fg-3">
            <span><span className="text-fg">{questions.length}</span> {questions.length === 1 ? "question" : "questions"}</span>
            <span className="flex items-center gap-1.5">{tradingCount > 0 && <span className="warming-pulse h-1.5 w-1.5 rounded-sm bg-signal" aria-hidden />}<span className="text-fg">{tradingCount}</span> trading now</span>
            {block !== undefined && <span>Block {block.toLocaleString("en-US")}</span>}
          </p>
        </div>
        <div role="search" aria-label="Find a market" className="w-full sm:w-auto sm:min-w-80">
          <div className="frame flex min-h-12 w-full items-center gap-3 bg-panel px-3 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-signal">
            <Search size={18} className="shrink-0 text-fg-3" aria-hidden />
            <label htmlFor="market-search" className="sr-only">Search markets</label>
            <input ref={searchInput} id="market-search" type="search" value={search}
              onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") clearSearch(); }}
              placeholder="Search events, teams, topics…" autoComplete="off" spellCheck={false}
              aria-controls="market-results" className="min-w-0 flex-1 bg-transparent py-3 text-sm text-fg outline-none placeholder:text-fg-3 [&::-webkit-search-cancel-button]:appearance-none" />
            {search && <button type="button" onClick={clearSearch} aria-label="Clear search" className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center text-fg-3 hover:bg-hover hover:text-fg"><X size={17} aria-hidden /></button>}
          </div>
          <p role="status" aria-live="polite" aria-atomic="true" className={cx("mt-2 text-right text-xs tnum text-fg-3", !terms.length && "sr-only")}>
            {terms.length ? `${board.length} of ${questions.length} questions` : `${questions.length} questions`}
          </p>
        </div>
      </div>

      {head.isError && <p role="alert" className="mt-6 text-xs text-ask">Live market data is unavailable. <button className="underline" onClick={() => head.refetch()}>Retry connection</button></p>}

      <div className="mt-12"><SectionRule name="LIVE NOW" index={1} /></div>
      <div id="market-results" className="mt-5">
        {questions.length === 0 ? <div className="frame bg-panel p-6">
          <h2 className="text-lg font-semibold text-fg">A new market is on the way</h2>
          <p className="mt-2 max-w-xl text-sm text-fg-2">The previous demo has been archived while we prepare its replacement. Existing balances and orders remain accessible in your portfolio.</p>
          <Link href="/portfolio" className="label mt-4 inline-flex min-h-11 items-center gap-2 bg-signal px-4 text-on-signal">View portfolio <ArrowRight size={14} aria-hidden /></Link>
        </div> : board.length === 0 ? <div className="frame bg-panel px-6 py-10">
          <h2 className="text-lg font-semibold text-fg">No matching markets</h2>
          <p className="mt-2 text-sm text-fg-2">Try another event, team, or topic.</p>
          <button type="button" onClick={clearSearch} className="label mt-5 inline-flex min-h-11 items-center gap-2 bg-signal px-4 text-on-signal">Show all markets <ArrowRight size={14} aria-hidden /></button>
        </div> : <ul className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
          {board.map((q) => <QuestionCard key={q.key} q={q} s={summaries.get(q.key)!} />)}
        </ul>}
      </div>

      {closed.length > 0 && <section aria-labelledby="closed-markets" className="mt-16">
        <SectionRule name="CLOSED" index={2} />
        <h2 id="closed-markets" className="sr-only">Closed markets</h2>
        <p className="mt-4 max-w-2xl text-xs leading-relaxed text-fg-3">Archived markets take no new positions. Open one to reduce a position, release collateral or claim a payout.</p>
        <ul className="frame mt-4 divide-y divide-line bg-ground">
          {[...closed.reduce((groups, mk) => groups.set(mk.title, [...(groups.get(mk.title) ?? []), mk]), new Map<string, MarketManifest[]>())]
            .map(([title, items]) => <ClosedQuestion key={title} title={title} items={items} />)}
        </ul>
      </section>}

      <p className="mt-10 max-w-2xl text-xs leading-relaxed text-fg-3">
        {discovery.isError ? "Registry discovery is unavailable. Showing the last verified markets." : discovery.isPending ? "Checking the verified markets against the registry…" : "Showing markets in the verified deployment. New listings become tradable after their deployment manifest is verified and updated."}
        {discovery.isError && <> <button className="underline" onClick={() => discovery.refetch()}>Retry discovery</button></>}
      </p>
    </main>
  );
}
