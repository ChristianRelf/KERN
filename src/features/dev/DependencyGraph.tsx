/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Dependency graph: one package at a time, with what depends on it (left)
// and what it depends on (right). Showing a neighbourhood keeps the graph
// readable and fast even for lockfiles with thousands of packages.

import { ReactFlow, Background, Controls, type Edge, type Node, MarkerType } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { AdvisoryFinding, DepPackage, DepReport } from "@/lib/types";
import { Select } from "@/components/ui/Controls";
import { depKey } from "./Dependencies";

const MAX_SIDE = 40;

export default function DependencyGraph({ report, findings, onOpen }: { report: DepReport; findings: Map<string, AdvisoryFinding>; onOpen: (p: DepPackage) => void }) {
  const byKey = useMemo(() => new Map(report.packages.filter((p) => p.resolved).map((p) => [depKey(p), p])), [report]);
  const out = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const [a, b] of report.edges) m.set(a, [...(m.get(a) ?? []), b]);
    return m;
  }, [report]);
  const inc = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const [a, b] of report.edges) m.set(b, [...(m.get(b) ?? []), a]);
    return m;
  }, [report]);
  // Roots: edge sources that aren't themselves packages (the project itself).
  const roots = useMemo(() => [...new Set(report.edges.map(([a]) => a).filter((a) => !byKey.has(a)))], [report, byKey]);
  const [focus, setFocus] = useState<string>(roots[0] ?? "");
  const [q, setQ] = useState("");
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? [...byKey.values()].filter((p) => p.name.toLowerCase().includes(s)).slice(0, 8) : [];
  }, [q, byKey]);

  const label = (k: string) => {
    const p = byKey.get(k);
    if (p) return `${p.name} ${p.resolved}`;
    return k.replace(/^[^:]+:/, "");
  };

  const { nodes, edges, hidden } = useMemo(() => {
    const left = (inc.get(focus) ?? []).slice(0, MAX_SIDE);
    const right = (out.get(focus) ?? []).slice(0, MAX_SIDE);
    const hidden = Math.max(0, (inc.get(focus)?.length ?? 0) - MAX_SIDE) + Math.max(0, (out.get(focus)?.length ?? 0) - MAX_SIDE);
    const node = (id: string, x: number, y: number, kind: "focus" | "side"): Node => {
      const p = byKey.get(id);
      const vuln = p && findings.has(depKey(p));
      return {
        id,
        position: { x, y },
        data: { label: label(id) },
        className: `dep-node ${kind === "focus" ? "dep-node--focus" : ""} ${vuln ? "dep-node--vuln" : ""} ${p && p.direct === false ? "dep-node--transitive" : ""}`,
        draggable: false,
      };
    };
    const gap = 38;
    const nodes: Node[] = [node(focus, 0, 0, "focus")];
    left.forEach((k, i) => nodes.push(node(k, -320, (i - (left.length - 1) / 2) * gap, "side")));
    right.forEach((k, i) => nodes.push(node(k, 320, (i - (right.length - 1) / 2) * gap, "side")));
    const marker = { type: MarkerType.ArrowClosed, width: 12, height: 12 };
    const edges: Edge[] = [...left.map((k) => ({ id: `${k}>${focus}`, source: k, target: focus, markerEnd: marker })), ...right.map((k) => ({ id: `${focus}>${k}`, source: focus, target: k, markerEnd: marker }))];
    return { nodes, edges, hidden };
  }, [focus, inc, out, byKey, findings]);

  if (!report.edges.length)
    return <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>The relationships between packages come from lockfiles; none were found here.</span>;

  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8 }}>
        <div className="input-wrap grow" style={{ position: "relative" }}>
          <Search />
          <input className="input" placeholder="Find a package to centre on" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find package" />
          {matches.length > 0 && (
            <div className="menu deps-graph__results">
              {matches.map((p) => (
                <button key={depKey(p)} type="button" className="menu__item" onClick={() => (setFocus(depKey(p)), setQ(""))}>
                  <span className="mono truncate">{p.name}</span>
                  <span className="faint">{p.resolved}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {roots.length > 1 && (
          <Select value={roots.includes(focus) ? focus : ""} onChange={setFocus} placeholder="Project packages" ariaLabel="Project package" options={roots.map((r) => ({ value: r, label: label(r) }))} />
        )}
      </div>
      <div className="deps-graph">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          minZoom={0.2}
          maxZoom={2}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, n) => {
            if (n.id === focus) {
              const p = byKey.get(n.id);
              if (p) onOpen(p);
            } else setFocus(n.id);
          }}
        >
          <Background gap={20} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
        Click a package to centre on it; click the centre package for details.{hidden > 0 && ` ${hidden} more relationship${hidden === 1 ? "" : "s"} not shown.`}
      </span>
    </div>
  );
}
