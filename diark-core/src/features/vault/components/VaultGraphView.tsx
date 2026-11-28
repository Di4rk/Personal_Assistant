import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import type { VaultGraphDto, VaultGraphNodeDto } from "../types";

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
  hideFloatingControls?: boolean;
  className?: string;
}

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
  if (node.isUnresolved) return "#64748B";
  let hash = 0;
  for (let i = 0; i < node.folder.length; i += 1) {
    hash = (hash * 31 + node.folder.charCodeAt(i)) | 0;
  }
  return FOLDER_COLORS[Math.abs(hash) % FOLDER_COLORS.length];
}

export const VaultGraphView = forwardRef<VaultGraphViewHandle, VaultGraphViewProps>(
  (
    { graph, activeNoteId, mode, onSelectNode, hideFloatingControls = false, className = "" },
    ref
  ) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [hoveredId, setHoveredId] = useState<string | null>(null);
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
    if (mode === "global" || !activeNoteId) {
      return graph;
    }

    const neighborIds = new Set<string>([activeNoteId]);
    for (const edge of graph.edges) {
      if (edge.source === activeNoteId) neighborIds.add(edge.target);
      if (edge.target === activeNoteId) neighborIds.add(edge.source);
    }

    const nodes = graph.nodes.filter((n) => neighborIds.has(n.id));
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
    return { nodes, edges };
  }, [activeNoteId, graph, mode]);

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

  useEffect(() => {
    const sim = simRef.current;
    const prevPos = new Map<string, { x: number; y: number }>();
    for (const oldNode of sim.nodes) {
      prevPos.set(oldNode.data.id, { x: oldNode.x, y: oldNode.y });
    }

    const count = Math.max(1, filtered.nodes.length);
    const radius = mode === "local" ? Math.min(88, 28 + count * 8) : Math.min(220, 60 + count * 6);

    const nextNodes: SimNode[] = filtered.nodes.map((node, idx) => {
      const prev = prevPos.get(node.id);
      if (prev) {
        return { data: node, x: prev.x, y: prev.y, vx: 0, vy: 0, pinned: false };
      }
      if (node.id === activeNoteId && mode === "local") {
        return { data: node, x: 0, y: 0, vx: 0, vy: 0, pinned: false };
      }
      const angle = (idx / count) * Math.PI * 2;
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
          11,
          (isCurrent ? 6.5 : 4) + Math.sqrt(node.data.linkCount) * 1.15
        );
        const radius = isHovered ? baseRadius + 1.8 : baseRadius;
        const fill = colorForNode(node.data, isCurrent);

        ctx.globalAlpha = isDimmed ? 0.28 : 1;

        if (isCurrent || isHovered) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, radius + 4.5, 0, Math.PI * 2);
          ctx.fillStyle = isCurrent
            ? "rgba(47, 107, 255, 0.22)"
            : "rgba(107, 155, 255, 0.16)";
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
          mode === "local" ||
          sim.zoom >= 0.85 ||
          isCurrent ||
          isHovered ||
          node.data.linkCount >= 2;
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
        draw();
        return;
      }

      const repulsion = mode === "local" ? 1350 : 2100;
      const springLen = mode === "local" ? 68 : 90;
      const springK = 0.045;
      const gravity = 0.018;
      const damping = 0.84;

      for (let i = 0; i < n; i += 1) {
        const a = sim.nodes[i];
        if (a.pinned) continue;
        a.vx += -a.x * gravity;
        a.vy += -a.y * gravity;

        for (let j = i + 1; j < n; j += 1) {
          const b = sim.nodes[j];
          const dx = b.x - a.x || 0.5;
          const dy = b.y - a.y || 0.5;
          const distSq = Math.max(36, dx * dx + dy * dy);
          const dist = Math.sqrt(distSq);
          const force = repulsion / distSq;
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
        node.vx *= damping;
        node.vy *= damping;
        node.x += node.vx;
        node.y += node.vy;
        const speed = Math.abs(node.vx) + Math.abs(node.vy);
        if (speed > maxSpeed) maxSpeed = speed;
      }

      sim.energy = maxSpeed;
      draw();

      if (running && (sim.energy > 0.08 || dragStateRef.current.kind === "node")) {
        rafId = window.requestAnimationFrame(stepPhysics);
      } else {
        rafId = 0;
      }
    };

    rafId = window.requestAnimationFrame(stepPhysics);
    return () => {
      running = false;
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [activeNoteId, filtered, mode, size]);

  useEffect(() => {
    drawRef.current();
  }, [hoveredId]);

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
    const hitR = 14 / simRef.current.zoom;
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
      drawRef.current();
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
        onSelectNode(drag.node.data);
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
