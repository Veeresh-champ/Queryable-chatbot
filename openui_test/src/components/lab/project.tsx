"use client";

import { useMemo, useState } from "react";
import { forceCollide, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import { arc } from "d3-shape";

import { Tip, series } from "@/components/lab/shared";

/**
 * Animated views for the project lab (backend/project_lab.py): any project's
 * company data, such as the VAF samples. Every animation starts once the
 * tile scrolls into view (`visible`) and is skipped for reduced motion by
 * the lab's CSS. Colour follows the dataset or use case (fixed slot order),
 * never the rank.
 */

export type LabAccount = {
  id: number;
  name: string;
  country: string | null;
  dataset: string;
  label: string;
  size: number | null;
  finance: number | null;
  size_band: string | null;
  growth: boolean | null;
  cases: string[];
  capabilities: Record<string, boolean>;
};
export type LabDataset = { name: string; label: string; accounts: number; rows: number; completeness: number; fields: number; size_field: string | null };
export type LabUseCase = { id: string; title: string; accounts: number };
export type WaffleRow = { dataset: string; capability: string; cells: (boolean | null)[] };
export type TopAccount = { name: string; label: string; country: string | null; size: number | null; finance: number | null };

const pct = (v: number) => `${Math.round(v * 100)}%`;
const short = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/* ------------------------------------------------------------- Constellation */

/** Use cases on an orbit around the portfolio; each account a star that flies out to its strongest use case. */
export function OpportunityConstellation({ accounts, cases, visible }: { accounts: LabAccount[]; cases: LabUseCase[]; visible: boolean }) {
  const [hover, setHover] = useState<{ x: number; y: number; account?: LabAccount; useCase?: LabUseCase } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const W = 720;
  const H = 520;
  const cx = W / 2;
  const cy = H / 2;
  const R = 190;
  const layout = useMemo(() => {
    const max = Math.max(1, ...cases.map((c) => c.accounts));
    const nodes = cases.map((c, i) => {
      const angle = (i / cases.length) * Math.PI * 2 - Math.PI / 2;
      return { ...c, i, x: cx + Math.cos(angle) * R, y: cy + Math.sin(angle) * R, r: 16 + Math.sqrt(c.accounts / max) * 22 };
    });
    const index = new Map(nodes.map((n) => [n.id, n]));
    const counts = new Map<string, number>();
    const stars = accounts
      .filter((a) => a.cases.length)
      .map((a) => {
        const node = index.get(a.cases[0])!;
        const k = counts.get(node.id) ?? 0;
        counts.set(node.id, k + 1);
        // Phyllotaxis spiral around the use-case node.
        const golden = 2.399963;
        const dist = node.r + 6 + Math.sqrt(k) * 6.2;
        return { a, node, x: node.x + Math.cos(k * golden) * dist, y: node.y + Math.sin(k * golden) * dist, k };
      });
    return { nodes, stars };
  }, [accounts, cases, cx, cy]);

  return (
    <div className="lab-chart plab-constellation" onPointerLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Accounts orbiting the use cases they qualify for">
        <defs>
          <radialGradient id="plab-core">
            <stop offset="0%" stopColor="var(--qc-accent)" stopOpacity="0.55" />
            <stop offset="100%" stopColor="var(--qc-accent)" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx={cx} cy={cy} r={R} className="plab-orbit" />
        <circle cx={cx} cy={cy} r={R * 0.45} className="plab-orbit plab-orbit--inner" />
        <circle cx={cx} cy={cy} r={70} fill="url(#plab-core)" className={`plab-core ${visible ? "is-on" : ""}`} />
        <text x={cx} y={cy - 4} textAnchor="middle" className="plab-core__value">{layout.stars.length}</text>
        <text x={cx} y={cy + 14} textAnchor="middle" className="plab-core__label">accounts with evidence</text>
        {layout.nodes.map((n) => (
          <line key={`l-${n.id}`} x1={cx} y1={cy} x2={n.x} y2={n.y} className={`plab-spoke ${visible ? "is-on" : ""}`}
                style={{ animationDelay: `${n.i * 90}ms`, stroke: series(n.i) }} />
        ))}
        {layout.stars.map(({ a, node, x, y, k }) => {
          const dim = focus && focus !== node.id;
          return (
            <circle key={a.id} r={2.2 + (a.size ?? 0.3) * 3} fill={series(node.i)}
                    className={`plab-star ${visible ? "is-on" : ""} ${dim ? "is-dim" : ""}`}
                    style={{ ["--from" as string]: `translate(${cx}px, ${cy}px)`, ["--to" as string]: `translate(${x}px, ${y}px)`,
                             animationDelay: `${300 + node.i * 80 + Math.min(k, 60) * 14}ms` }}
                    onPointerEnter={() => setHover({ x: (x / W) * 100, y: (y / H) * 100, account: a })} />
          );
        })}
        {layout.nodes.map((n) => (
          <g key={n.id} className={`plab-node ${visible ? "is-on" : ""} ${focus === n.id ? "is-focus" : ""}`} style={{ animationDelay: `${n.i * 90}ms` }}
             transform={`translate(${n.x}, ${n.y})`} tabIndex={0} role="button" aria-pressed={focus === n.id}
             aria-label={`${n.title}: ${n.accounts} accounts`}
             onClick={() => setFocus(focus === n.id ? null : n.id)}
             onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setFocus(focus === n.id ? null : n.id)}
             onPointerEnter={() => setHover({ x: (n.x / W) * 100, y: (n.y / H) * 100, useCase: n })}>
            <circle r={n.r} fill={series(n.i)} className="plab-node__disc" />
            <circle r={n.r + 6} className="plab-node__halo" stroke={series(n.i)} />
            <text y={4} textAnchor="middle" className="plab-node__count">{n.accounts}</text>
            <text y={n.r + 18} textAnchor="middle" className="plab-node__label">{short(n.title, 26)}</text>
          </g>
        ))}
      </svg>
      {hover && (
        <Tip x={hover.x} y={hover.y}>
          {hover.account ? (
            <>
              <b>{hover.account.name}</b>
              <span>{hover.account.label} · {hover.account.country ?? "country unknown"}</span>
              <span>{hover.account.cases.length} use case(s)</span>
            </>
          ) : hover.useCase ? (
            <>
              <b>{hover.useCase.title}</b>
              <span>{hover.useCase.accounts} accounts · click to highlight</span>
            </>
          ) : null}
        </Tip>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- Galaxy */

type GalaxyNode = SimulationNodeDatum & { a: LabAccount; r: number; group: number; tx: number; ty: number };

/** Every account as a bubble, settling into its dataset's cluster; bubble size = size percentile in its dataset. */
export function AccountGalaxy({ accounts, datasets, visible }: { accounts: LabAccount[]; datasets: LabDataset[]; visible: boolean }) {
  const [hover, setHover] = useState<GalaxyNode | null>(null);
  const W = 720;
  const H = 460;
  const nodes = useMemo(() => {
    const groups = datasets.map((d) => d.name);
    const centers = groups.map((_, i) => {
      const angle = (i / groups.length) * Math.PI * 2 - Math.PI / 2;
      return { x: W / 2 + Math.cos(angle) * 190, y: H / 2 + Math.sin(angle) * 140 };
    });
    const list: GalaxyNode[] = accounts.map((a) => {
      const group = Math.max(0, groups.indexOf(a.dataset));
      return { a, group, r: 2.5 + (a.size ?? 0.25) * 7, x: centers[group].x, y: centers[group].y, tx: centers[group].x, ty: centers[group].y };
    });
    // Seeded jitter so the layout is stable between renders.
    list.forEach((n, i) => {
      n.x = (n.x ?? 0) + Math.cos(i * 12.9898) * 20;
      n.y = (n.y ?? 0) + Math.sin(i * 78.233) * 20;
    });
    const sim = forceSimulation(list)
      .force("x", forceX<GalaxyNode>((d) => d.tx).strength(0.09))
      .force("y", forceY<GalaxyNode>((d) => d.ty).strength(0.09))
      .force("collide", forceCollide<GalaxyNode>((d) => d.r + 1.2))
      .stop();
    for (let i = 0; i < 220; i += 1) sim.tick();
    return { list, centers };
  }, [accounts, datasets]);

  return (
    <div className="lab-chart" onPointerLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Accounts clustered by dataset">
        {nodes.list.map((n, i) => (
          <circle key={n.a.id} r={n.r} fill={series(n.group)} className={`plab-bubble ${visible ? "is-on" : ""}`}
                  style={{ ["--from" as string]: `translate(${W / 2}px, ${H / 2}px)`, ["--to" as string]: `translate(${n.x}px, ${n.y}px)`,
                           animationDelay: `${(i % 120) * 9}ms` }}
                  onPointerEnter={() => setHover(n)} />
        ))}
        {datasets.map((d, i) => (
          <text key={`${d.name}-${i}`} x={nodes.centers[i].x} y={nodes.centers[i].y - 62} textAnchor="middle"
                className={`plab-cluster-label ${visible ? "is-on" : ""}`} style={{ animationDelay: `${600 + i * 80}ms` }}>
            {short(d.label.replace(" (VAF)", ""), 22)} · {d.accounts}
          </text>
        ))}
      </svg>
      {hover && (
        <Tip x={((hover.x ?? 0) / W) * 100} y={((hover.y ?? 0) / H) * 100}>
          <b>{hover.a.name}</b>
          <span>{hover.a.label} · {hover.a.country ?? "country unknown"}</span>
          <span>{hover.a.size != null ? `Size: top ${pct(1 - hover.a.size + 0.001)} of dataset` : "Size not recorded"}</span>
        </Tip>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- Radial ranking */

/** The 24 largest accounts (size + financial percentile) as arcs that sweep around a dial. */
export function RadialRanking({ top, datasets, visible }: { top: TopAccount[]; datasets: LabDataset[]; visible: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const S = 560;
  const inner = 92;
  const outer = 250;
  const step = (Math.PI * 2) / Math.max(1, top.length);
  const labels = datasets.map((d) => d.label);
  const shape = arc<{ start: number; end: number; r: number }>()
    .innerRadius(inner)
    .outerRadius((d) => d.r)
    .startAngle((d) => d.start)
    .endAngle((d) => d.end)
    .padAngle(0.02)
    .cornerRadius(3);
  const score = (t: TopAccount) => ((t.size ?? 0) + (t.finance ?? t.size ?? 0)) / 2;
  const focus = hover != null ? top[hover] : null;
  return (
    <div className="lab-chart">
      <svg viewBox={`${-S / 2} ${-S / 2} ${S} ${S}`} role="img" aria-label="Largest accounts">
        {[0.25, 0.5, 0.75, 1].map((v) => (
          <circle key={v} r={inner + (outer - inner) * v} className="plab-dial" />
        ))}
        {top.map((t, i) => {
          const r = inner + (outer - inner) * score(t);
          const color = series(Math.max(0, labels.indexOf(t.label)));
          return (
            <g key={`${t.name}-${i}`} className={`plab-ray ${visible ? "is-on" : ""} ${hover != null && hover !== i ? "is-dim" : ""}`}
               style={{ animationDelay: `${i * 45}ms` }} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
              <path d={shape({ start: i * step, end: (i + 1) * step, r }) ?? ""} fill={color} />
              <text transform={`rotate(${((i + 0.5) * step * 180) / Math.PI - 90}) translate(${r + 6},0)${(i + 0.5) * step > Math.PI ? " rotate(180)" : ""}`}
                    textAnchor={(i + 0.5) * step > Math.PI ? "end" : "start"} dy="0.32em" className="plab-ray__label">
                {short(t.name, 18)}
              </text>
            </g>
          );
        })}
        <text textAnchor="middle" y={-6} className="plab-core__value">{focus ? pct(score(focus)) : top.length}</text>
        <text textAnchor="middle" y={14} className="plab-core__label">{focus ? short(focus.name, 22) : "largest accounts"}</text>
        {focus && <text textAnchor="middle" y={30} className="plab-core__label">{focus.label.replace(" (VAF)", "")}</text>}
      </svg>
      <ul className="plab-legend">
        {datasets.map((d, i) => (
          <li key={`${d.name}-${i}`}><span style={{ background: series(i) }} />{d.label.replace(" (VAF)", "")}</li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------- Waffle */

/** One square per account for every yes/no capability: the gaps are where to sell. */
export function CapabilityWaffle({ rows, visible }: { rows: WaffleRow[]; visible: boolean }) {
  return (
    <div className="plab-waffle">
      {rows.map((row, r) => {
        const yes = row.cells.filter((c) => c === true).length;
        const no = row.cells.filter((c) => c === false).length;
        return (
          <div key={`${row.dataset}-${row.capability}`} className="plab-waffle__row">
            <div className="plab-waffle__head">
              <strong>{row.capability}</strong>
              <span>{row.dataset.replace(" (VAF)", "")} · {pct(yes / Math.max(1, yes + no))} yes · {no} gap{no === 1 ? "" : "s"}</span>
            </div>
            <div className="plab-waffle__cells" role="img" aria-label={`${row.capability}: ${yes} yes, ${no} no`}>
              {row.cells.map((c, i) => (
                <i key={i} data-state={c === true ? "yes" : c === false ? "no" : "unknown"} className={visible ? "is-on" : ""}
                   style={{ animationDelay: `${r * 60 + i * 9}ms` }} />
              ))}
            </div>
          </div>
        );
      })}
      <p className="plab-waffle__key"><i data-state="yes" className="is-on" /> Yes <i data-state="no" className="is-on" /> No (opportunity) <i data-state="unknown" className="is-on" /> Not recorded</p>
    </div>
  );
}

/* ------------------------------------------------------------- Health rings */

/** Concentric rings: how complete each dataset is (filled fields). */
export function HealthRings({ datasets, visible }: { datasets: LabDataset[]; visible: boolean }) {
  const S = 300;
  return (
    <div className="plab-rings">
      <svg viewBox={`${-S / 2} ${-S / 2} ${S} ${S}`} role="img" aria-label="Data completeness by dataset">
        {datasets.map((d, i) => {
          const r = 130 - i * 17;
          return (
            <g key={`${d.name}-${i}`}>
              <circle r={r} className="plab-ring__track" />
              <circle r={r} pathLength={1} className="plab-ring__arc" stroke={series(i)} transform="rotate(-90)"
                      style={{ strokeDasharray: `${visible ? d.completeness : 0} 1`, transitionDelay: `${i * 120}ms` }}>
                <title>{`${d.label}: ${pct(d.completeness)} complete`}</title>
              </circle>
            </g>
          );
        })}
      </svg>
      <ul className="plab-legend plab-legend--list">
        {datasets.map((d, i) => (
          <li key={`${d.name}-${i}`}>
            <span style={{ background: series(i) }} />
            {d.label.replace(" (VAF)", "")}
            <b>{pct(d.completeness)}</b>
            <em>{d.accounts} accounts · {d.fields} fields</em>
          </li>
        ))}
      </ul>
    </div>
  );
}
