import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { RotateCcw, Search, SlidersHorizontal, X, ZoomIn, ZoomOut } from "lucide-react";
import type { VaultGraphDto, VaultGraphNodeDto } from "../types";
import {
  buildDisplayGraph,
  FOLDER_NODE_FOLDER,
  isVirtualGraphNode,
  TAG_NODE_FOLDER,
} from "../utils/vaultGraphTransform";

export interface VaultGraphViewHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  resetCamera: () => void;
}

interface VaultGraphViewProps {
  graph: VaultGraphDto;
  activeNoteId: string | null;
  mode: "local" | "global";
  onSelectNode: (node: VaultGraphNodeDto) => void;
  noteTagsById?: ReadonlyMap<string, readonly string[]>;
  hideFloatingControls?: boolean;
  className?: string;
}

const EMPTY_TAGS_MAP: ReadonlyMap<string, readonly string[]> = new Map();

interface SimNode {
  data: VaultGraphNodeDto;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned: boolean;
}

const FOLDER_COLORS = [
  "#6B9BFF",
  "#34D399",
  "#FBBF24",
  "#F472B6",
  "#38BDF8",
  "#A78BFA",
  "#FB923C",
];

function colorForNode(node: VaultGraphNodeDto, isActive: boolean): string {
  if (isActive) return "#2F6BFF";
  if (node.folder === TAG_NODE_FOLDER) return "#34D399";
  if (node.folder === FOLDER_NODE_FOLDER) return "#818CF8";
  if (node.isUnresolved) return "#64748B";
  let hash = 0;
  for (let i = 0; i < node.folder.length; i += 1) {
    hash = (hash * 31 + node.folder.charCodeAt(i)) | 0;
  }
  return FOLDER_COLORS[Math.abs(hash) % FOLDER_COLORS.length];
}

export const VaultGraphView = forwardRef<VaultGraphViewHandle, VaultGraphViewProps>(
  (
    {
      graph,
      activeNoteId,
      mode,
      onSelectNode,
      noteTagsById,
      hideFloatingControls = false,
      className = "",
    },
    ref
  ) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [showOrphans, setShowOrphans] = useState<boolean>(true);
  const [showTagNodes, setShowTagNodes] = useState<boolean>(false);
  const [groupByFolder, setGroupByFolder] = useState<boolean>(false);
  const [showLabels, setShowLabels] = useState<boolean>(true);
  const [filterQuery, setFilterQuery] = useState<string>("");
  const [repulsionScale, setRepulsionScale] = useState<number>(1);
  const [springLenScale, setSpringLenScale] = useState<number>(1);
  const [gravityScale, setGravityScale] = useState<number>(1);

  const forcesRef = useRef({
    repulsionScale: 1,
    springLenScale: 1,
    gravityScale: 1,
    showLabels: true,
  });
  forcesRef.current = {
    repulsionScale,
    springLenScale,
    gravityScale,
    showLabels,
  };
  const [size, setSize] = useState<{ width: number; height: number }>({
    width: mode === "local" ? 280 : 800,
    height: mode === "local" ? 260 : 540,
  });

  const simRef = useRef<{
    nodes: SimNode[];
    nodeById: Map<string, SimNode>;
    edges: Array<{ a: SimNode; b: SimNode }>;
    camX: number;
    camY: number;
    zoom: number;
    energy: number;
  }>({
    nodes: [],
    nodeById: new Map(),
    edges: [],
    camX: 0,
    camY: 0,
    zoom: 1,
    energy: 1,
  });

  const dragStateRef = useRef<{
    kind: "none" | "node" | "pan";
    node: SimNode | null;
    startClientX: number;
    startClientY: number;
    startCamX: number;
    startCamY: number;
    moved: boolean;
  }>({
    kind: "none",
    node: null,
    startClientX: 0,
    startClientY: 0,
    startCamX: 0,
    startCamY: 0,
    moved: false,
  });

  const hoveredIdRef = useRef<string | null>(null);
  hoveredIdRef.current = hoveredId;

  const filtered = useMemo(() => {
    const baseGraph =
      mode === "global"
        ? buildDisplayGraph(graph, noteTagsById ?? EMPTY_TAGS_MAP, {
            showOrphans,
            showTagNodes,
            groupByFolder,
            searchQuery: filterQuery,
            keepNodeId: activeNoteId,
          })
        : graph;

    if (mode === "global" || !activeNoteId) {
      return baseGraph;
    }

    const neighborIds = new Set<string>([activeNoteId]);
    for (const edge of baseGraph.edges) {
      if (edge.source === activeNoteId) neighborIds.add(edge.target);
      if (edge.target === activeNoteId) neighborIds.add(edge.source);
    }

    const nodes = baseGraph.nodes.filter((n) => neighborIds.has(n.id));
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = baseGraph.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
    return { nodes, edges };
  }, [
    activeNoteId,
    filterQuery,
    graph,
    groupByFolder,
    mode,
    noteTagsById,
    showOrphans,
    showTagNodes,
  ]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.max(160, Math.floor(entry.contentRect.width));
        const h = Math.max(160, Math.floor(entry.contentRect.height));
        setSize({ width: w, height: h });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const drawRef = useRef<() => void>(() => {});
  const reheatRef = useRef<() => void>(() => {});

  useEffect(() => {
    const sim = simRef.current;
    const prevPos = new Map<string, { x: number; y: number }>();
    for (const oldNode of sim.nodes) {
      prevPos.set(oldNode.data.id, { x: oldNode.x, y: oldNode.y });
    }

    const spreadStep = mode === "local" ? 64 : 84;
    const goldenAngle = 2.399963229728653;

    const nextNodes: SimNode[] = filtered.nodes.map((node, idx) => {
      const prev = prevPos.get(node.id);
      if (prev) {
        return { data: node, x: prev.x, y: prev.y, vx: 0, vy: 0, pinned: false };
      }
      if (node.id === activeNoteId && mode === "local") {
        return { data: node, x: 0, y: 0, vx: 0, vy: 0, pinned: false };
      }
      const angle = idx * goldenAngle;
      const radius = spreadStep * Math.sqrt(idx + 1);
      return {
        data: node,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
        pinned: false,
      };
    });

    const nodeById = new Map<string, SimNode>();
    for (const n of nextNodes) {
      nodeById.set(n.data.id, n);
    }

    const nextEdges: Array<{ a: SimNode; b: SimNode }> = [];
    for (const e of filtered.edges) {
      const a = nodeById.get(e.source);
      const b = nodeById.get(e.target);
      if (a && b) nextEdges.push({ a, b });
    }

    sim.nodes = nextNodes;
    sim.nodeById = nodeById;
    sim.edges = nextEdges;
    sim.camX = 0;
    sim.camY = 0;
    sim.zoom = 1;
    sim.energy = 1;
  }, [activeNoteId, filtered, mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let rafId = 0;
    let running = true;

    const draw = () => {
      const sim = simRef.current;
      const dpr = window.devicePixelRatio || 1;
      const targetW = Math.floor(size.width * dpr);
      const targetH = Math.floor(size.height * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.fillStyle = "#080B12";
      ctx.fillRect(0, 0, size.width, size.height);

      ctx.translate(size.width / 2 + sim.camX, size.height / 2 + sim.camY);
      ctx.scale(sim.zoom, sim.zoom);

      const activeHovered = hoveredIdRef.current;
      const focusId = activeHovered ?? activeNoteId;
      const focusNeighbors = new Set<string>();
      if (focusId) {
        focusNeighbors.add(focusId);
        for (const e of sim.edges) {
          if (e.a.data.id === focusId) focusNeighbors.add(e.b.data.id);
          if (e.b.data.id === focusId) focusNeighbors.add(e.a.data.id);
        }
      }

      for (const edge of sim.edges) {
        const isHighlighted =
          focusId !== null &&
          (edge.a.data.id === focusId || edge.b.data.id === focusId);
        ctx.beginPath();
        ctx.moveTo(edge.a.x, edge.a.y);
        ctx.lineTo(edge.b.x, edge.b.y);
        ctx.strokeStyle = isHighlighted
          ? "rgba(107, 155, 255, 0.72)"
          : activeHovered
          ? "rgba(43, 57, 87, 0.25)"
          : "rgba(43, 57, 87, 0.65)";
        ctx.lineWidth = isHighlighted ? 1.5 / sim.zoom : 1 / sim.zoom;
        ctx.stroke();
      }

      for (const node of sim.nodes) {
        const isCurrent = node.data.id === activeNoteId;
        const isHovered = node.data.id === activeHovered;
        const isDimmed = activeHovered !== null && !focusNeighbors.has(node.data.id);

        const baseRadius = Math.min(
          20,
          (isCurrent ? 6.5 : 4) + Math.sqrt(node.data.linkCount) * 2.0
        );
        const radius = isHovered ? baseRadius + 1.8 : baseRadius;
        const fill = colorForNode(node.data, isCurrent);
        const isVirtual = isVirtualGraphNode(node.data);

        ctx.globalAlpha = isDimmed ? 0.28 : 1;

        if (isCurrent || isHovered || isVirtual) {
          ctx.beginPath();
          ctx.arc(
            node.x,
            node.y,
            radius + (isCurrent || isHovered ? 4.5 : 3),
            0,
            Math.PI * 2
          );
          ctx.fillStyle = isCurrent
            ? "rgba(47, 107, 255, 0.22)"
            : isHovered
            ? "rgba(107, 155, 255, 0.16)"
            : "rgba(129, 140, 248, 0.14)";
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
        if (node.data.isUnresolved) {
          ctx.fillStyle = "#0F1420";
          ctx.fill();
          ctx.setLineDash([2.5, 2]);
          ctx.strokeStyle = fill;
          ctx.lineWidth = 1.4 / sim.zoom;
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          ctx.fillStyle = fill;
          ctx.fill();
        }

        const showLabel =
          isCurrent ||
          isHovered ||
          (forcesRef.current.showLabels &&
            (mode === "local" || sim.zoom >= 0.85 || node.data.linkCount >= 2));
        if (showLabel) {
          const fontSize = Math.max(9.5, Math.min(12.5, 11 / Math.sqrt(sim.zoom)));
          ctx.font = `${isCurrent || isHovered ? "600" : "500"} ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillStyle = isCurrent || isHovered ? "#F4F4F5" : "#A1A1AA";
          const label =
            node.data.title.length > 26
              ? `${node.data.title.slice(0, 24)}...`
              : node.data.title;
          ctx.fillText(label, node.x, node.y + radius + 4);
        }

        ctx.globalAlpha = 1;
      }

      ctx.restore();
    };

    drawRef.current = draw;

    const stepPhysics = () => {
      const sim = simRef.current;
      const n = sim.nodes.length;
      if (n === 0) {
        rafId = 0;
        draw();
        return;
      }

      const {
        repulsionScale: rScale,
        springLenScale: sScale,
        gravityScale: gScale,
      } = forcesRef.current;
      const repulsion = (mode === "local" ? 2600 : 6800) * rScale;
      const springLen = (mode === "local" ? 95 : 135) * sScale;
      const springK = 0.04;
      const gravity = (mode === "local" ? 0.012 : 0.0085) * gScale;
      const damping = 0.86;
      const minSpacing = mode === "local" ? 76 : 108;
      const maxSpeedCap = 14;

      for (let i = 0; i < n; i += 1) {
        const a = sim.nodes[i];
        if (!a.pinned) {
          a.vx += -a.x * gravity;
          a.vy += -a.y * gravity;
        }

        for (let j = i + 1; j < n; j += 1) {
          const b = sim.nodes[j];
          const dx = b.x - a.x || (i % 2 === 0 ? 0.8 : -0.8);
          const dy = b.y - a.y || (j % 2 === 0 ? 0.8 : -0.8);
          const distSq = Math.max(64, dx * dx + dy * dy);
          const dist = Math.sqrt(distSq);

          let force = repulsion / distSq;
          if (dist < minSpacing) {
            force += (minSpacing - dist) * 0.14;
          }

          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;

          if (!a.pinned) {
            a.vx -= fx;
            a.vy -= fy;
          }
          if (!b.pinned) {
            b.vx += fx;
            b.vy += fy;
          }
        }
      }

      for (const edge of sim.edges) {
        const dx = edge.b.x - edge.a.x;
        const dy = edge.b.y - edge.a.y;
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const delta = (dist - springLen) * springK;
        const fx = (dx / dist) * delta;
        const fy = (dy / dist) * delta;
        if (!edge.a.pinned) {
          edge.a.vx += fx;
          edge.a.vy += fy;
        }
        if (!edge.b.pinned) {
          edge.b.vx -= fx;
          edge.b.vy -= fy;
        }
      }

      let maxSpeed = 0;
      for (const node of sim.nodes) {
        if (node.pinned) {
          node.vx = 0;
          node.vy = 0;
          continue;
        }
        node.vx = Math.max(-maxSpeedCap, Math.min(maxSpeedCap, node.vx * damping));
        node.vy = Math.max(-maxSpeedCap, Math.min(maxSpeedCap, node.vy * damping));
        node.x += node.vx;
        node.y += node.vy;
        const speed = Math.abs(node.vx) + Math.abs(node.vy);
        if (speed > maxSpeed) maxSpeed = speed;
      }

      sim.energy = maxSpeed;
      draw();

      if (running && (sim.energy > 0.03 || dragStateRef.current.kind === "node")) {
        rafId = window.requestAnimationFrame(stepPhysics);
      } else {
        rafId = 0;
      }
    };

    reheatRef.current = () => {
      if (!running) return;
      simRef.current.energy = Math.max(simRef.current.energy, 1);
      if (rafId === 0) {
        rafId = window.requestAnimationFrame(stepPhysics);
      }
    };

    rafId = window.requestAnimationFrame(stepPhysics);
    return () => {
      running = false;
      reheatRef.current = () => {};
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [activeNoteId, filtered, mode, size]);

  useEffect(() => {
    drawRef.current();
  }, [hoveredId, showLabels]);

  useEffect(() => {
    reheatRef.current();
  }, [repulsionScale, springLenScale, gravityScale]);

  const toWorld = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const sim = simRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    return {
      x: (sx - size.width / 2 - sim.camX) / sim.zoom,
      y: (sy - size.height / 2 - sim.camY) / sim.zoom,
    };
  };

  const hitTestNode = (worldX: number, worldY: number): SimNode | null => {
    const hitR = 16 / simRef.current.zoom;
    for (let i = simRef.current.nodes.length - 1; i >= 0; i -= 1) {
      const node = simRef.current.nodes[i];
      const dx = worldX - node.x;
      const dy = worldY - node.y;
      if (dx * dx + dy * dy <= hitR * hitR) {
        return node;
      }
    }
    return null;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const world = toWorld(e.clientX, e.clientY);
    const hit = hitTestNode(world.x, world.y);
    e.currentTarget.setPointerCapture(e.pointerId);

    if (hit) {
      hit.pinned = true;
      dragStateRef.current = {
        kind: "node",
        node: hit,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startCamX: simRef.current.camX,
        startCamY: simRef.current.camY,
        moved: false,
      };
      reheatRef.current();
    } else {
      dragStateRef.current = {
        kind: "pan",
        node: null,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startCamX: simRef.current.camX,
        startCamY: simRef.current.camY,
        moved: false,
      };
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragStateRef.current;
    const world = toWorld(e.clientX, e.clientY);

    if (drag.kind === "node" && drag.node) {
      if (
        Math.abs(e.clientX - drag.startClientX) > 3 ||
        Math.abs(e.clientY - drag.startClientY) > 3
      ) {
        drag.moved = true;
      }
      drag.node.x = world.x;
      drag.node.y = world.y;
      reheatRef.current();
      return;
    }

    if (drag.kind === "pan") {
      if (
        Math.abs(e.clientX - drag.startClientX) > 3 ||
        Math.abs(e.clientY - drag.startClientY) > 3
      ) {
        drag.moved = true;
      }
      simRef.current.camX = drag.startCamX + (e.clientX - drag.startClientX);
      simRef.current.camY = drag.startCamY + (e.clientY - drag.startClientY);
      drawRef.current();
      return;
    }

    const hit = hitTestNode(world.x, world.y);
    const nextHover = hit ? hit.data.id : null;
    if (nextHover !== hoveredIdRef.current) {
      setHoveredId(nextHover);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragStateRef.current;
    if (drag.kind === "node" && drag.node) {
      drag.node.pinned = false;
      if (!drag.moved) {
        if (!isVirtualGraphNode(drag.node.data)) {
          onSelectNode(drag.node.data);
        }
      } else {
        reheatRef.current();
      }
    }
    dragStateRef.current.kind = "none";
    dragStateRef.current.node = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    drawRef.current();
  };

  const adjustZoom = (factor: number) => {
    const next = Math.min(2.6, Math.max(0.4, simRef.current.zoom * factor));
    simRef.current.zoom = next;
    drawRef.current();
  };

  const resetCamera = () => {
    simRef.current.camX = 0;
    simRef.current.camY = 0;
    simRef.current.zoom = 1;
    drawRef.current();
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    adjustZoom(e.deltaY < 0 ? 1.12 : 0.89);
  };

  useImperativeHandle(ref, () => ({
    zoomIn: () => adjustZoom(1.2),
    zoomOut: () => adjustZoom(0.84),
    resetCamera,
  }));

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden rounded-lg border border-[#1D263B] bg-[#080B12] ${className}`}
    >
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={() => setHoveredId(null)}
        onWheel={handleWheel}
        className={`block h-full w-full ${
          hoveredId ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"
        }`}
      />

      {mode === "global" && (
        <div className="pointer-events-auto absolute right-3 top-3 z-10 flex flex-col items-end gap-2">
          <button
            type="button"
            onClick={() => setIsSettingsOpen((prev) => !prev)}
            title="Tùy chỉnh đồ thị"
            aria-label="Tùy chỉnh đồ thị"
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
              isSettingsOpen
                ? "border-[#2F6BFF]/60 bg-[#151C2C] text-[#6B9BFF]"
                : "border-[#1D263B] bg-[#0F1420] text-zinc-300 hover:bg-[#151C2C]"
            }`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span>Bộ lọc &amp; Lực</span>
          </button>

          {isSettingsOpen && (
            <div className="w-64 rounded-xl border border-[#1D263B] bg-[#0F1420] p-3 text-xs text-zinc-300 shadow-xl space-y-3">
              <div className="flex items-center justify-between border-b border-[#1D263B] pb-2">
                <span className="font-semibold text-zinc-100">Tùy chỉnh đồ thị</span>
                <button
                  type="button"
                  onClick={() => setIsSettingsOpen(false)}
                  className="rounded p-0.5 text-zinc-400 hover:bg-[#151C2C] hover:text-zinc-100 cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-zinc-500" />
                <input
                  type="text"
                  value={filterQuery}
                  onChange={(e) => setFilterQuery(e.target.value)}
                  placeholder="Lọc theo tên hoặc thư mục..."
                  className="w-full rounded-md border border-[#1D263B] bg-[#080B12] pl-7 pr-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-500 focus:border-[#2F6BFF] focus:outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="flex items-center justify-between cursor-pointer">
                  <span>Hiện ghi chú lẻ</span>
                  <input
                    type="checkbox"
                    checked={showOrphans}
                    onChange={(e) => setShowOrphans(e.target.checked)}
                    className="accent-[#2F6BFF] cursor-pointer"
                  />
                </label>
                <label className="flex items-center justify-between cursor-pointer">
                  <span>Gom cụm theo #tag</span>
                  <input
                    type="checkbox"
                    checked={showTagNodes}
                    onChange={(e) => setShowTagNodes(e.target.checked)}
                    className="accent-[#2F6BFF] cursor-pointer"
                  />
                </label>
                <label className="flex items-center justify-between cursor-pointer">
                  <span>Gom cụm theo thư mục</span>
                  <input
                    type="checkbox"
                    checked={groupByFolder}
                    onChange={(e) => setGroupByFolder(e.target.checked)}
                    className="accent-[#2F6BFF] cursor-pointer"
                  />
                </label>
                <label className="flex items-center justify-between cursor-pointer">
                  <span>Hiện tên ghi chú</span>
                  <input
                    type="checkbox"
                    checked={showLabels}
                    onChange={(e) => setShowLabels(e.target.checked)}
                    className="accent-[#2F6BFF] cursor-pointer"
                  />
                </label>
              </div>

              <div className="space-y-2 border-t border-[#1D263B] pt-2">
                <label className="block space-y-1">
                  <div className="flex justify-between text-[11px] text-zinc-400">
                    <span>Lực đẩy</span>
                    <span className="font-mono">{repulsionScale.toFixed(1)}x</span>
                  </div>
                  <input
                    type="range"
                    min="0.4"
                    max="2.0"
                    step="0.1"
                    value={repulsionScale}
                    onChange={(e) => setRepulsionScale(Number(e.target.value))}
                    className="w-full accent-[#2F6BFF] cursor-pointer"
                  />
                </label>
                <label className="block space-y-1">
                  <div className="flex justify-between text-[11px] text-zinc-400">
                    <span>Khoảng cách dây</span>
                    <span className="font-mono">{springLenScale.toFixed(1)}x</span>
                  </div>
                  <input
                    type="range"
                    min="0.5"
                    max="2.0"
                    step="0.1"
                    value={springLenScale}
                    onChange={(e) => setSpringLenScale(Number(e.target.value))}
                    className="w-full accent-[#2F6BFF] cursor-pointer"
                  />
                </label>
                <label className="block space-y-1">
                  <div className="flex justify-between text-[11px] text-zinc-400">
                    <span>Lực hút tâm</span>
                    <span className="font-mono">{gravityScale.toFixed(1)}x</span>
                  </div>
                  <input
                    type="range"
                    min="0.3"
                    max="2.0"
                    step="0.1"
                    value={gravityScale}
                    onChange={(e) => setGravityScale(Number(e.target.value))}
                    className="w-full accent-[#2F6BFF] cursor-pointer"
                  />
                </label>
              </div>

              <button
                type="button"
                onClick={() => {
                  setFilterQuery("");
                  setShowOrphans(true);
                  setShowTagNodes(false);
                  setGroupByFolder(false);
                  setShowLabels(true);
                  setRepulsionScale(1);
                  setSpringLenScale(1);
                  setGravityScale(1);
                }}
                className="w-full rounded-md border border-[#1D263B] bg-[#080B12] py-1 text-[11px] text-zinc-300 hover:bg-[#151C2C] transition-colors cursor-pointer"
              >
                Mặc định
              </button>
            </div>
          )}
        </div>
      )}

      {!hideFloatingControls && (
        <div className="pointer-events-auto absolute right-2 top-2 flex items-center gap-1 rounded-md border border-[#1D263B] bg-[#0F1420]/90 p-0.5">
          <button
            type="button"
            onClick={() => adjustZoom(1.2)}
            title="Phóng to"
            className="rounded p-1 text-zinc-400 hover:bg-[#151C2C] hover:text-zinc-100 cursor-pointer"
          >
            <ZoomIn className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => adjustZoom(0.84)}
            title="Thu nhỏ"
            className="rounded p-1 text-zinc-400 hover:bg-[#151C2C] hover:text-zinc-100 cursor-pointer"
          >
            <ZoomOut className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={resetCamera}
            title="Đặt lại góc nhìn"
            className="rounded p-1 text-zinc-400 hover:bg-[#151C2C] hover:text-zinc-100 cursor-pointer"
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        </div>
      )}

      {filtered.nodes.length <= 1 && mode === "local" && (
        <div className="pointer-events-none absolute inset-x-3 bottom-2 text-center text-[10px] text-zinc-500">
          Gõ @ hoặc [[ để nối ghi chú thành mạng liên kết
        </div>
      )}
    </div>
  );
});

VaultGraphView.displayName = "VaultGraphView";
