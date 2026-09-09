import React, { useState } from "react";
import type { CategoryAxisData } from "../utils/forecastEngine";

interface AcademicRadarChartProps {
  data: CategoryAxisData[];
  size?: number;
  className?: string;
}

/**
 * Pure SVG Academic Radar Chart (4 Trục kiến thức UIT).
 *
 * Tính năng:
 * - Render thuần SVG, zero external chart dependencies, zero memory leak, <16ms 60FPS.
 * - 4 lớp lưới đa giác đồng tâm (25%, 50%, 75%, 100% max score 10.0).
 * - Tọa độ 4 trục:
 *     + Đỉnh trên: Đại cương
 *     + Đỉnh phải: Cơ sở ngành
 *     + Đỉnh dưới: Chuyên ngành
 *     + Đỉnh trái: Điều kiện / Bổ trợ
 * - Interactive tooltip khi hover vào từng đỉnh trục hoặc di chuột qua biểu đồ.
 */
export const AcademicRadarChart: React.FC<AcademicRadarChartProps> = ({
  data,
  size = 320,
  className = "",
}) => {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const center = size / 2;
  const radius = (size / 2) * 0.72; // Để lại lề cho nhãn trục
  const gridLevels = [0.25, 0.5, 0.75, 1.0];
  const maxScore = 10.0;

  // 4 góc của 4 trục (Top, Right, Bottom, Left)
  // Góc tính theo radian: -PI/2 (trên), 0 (phải), PI/2 (dưới), PI (trái)
  const axisAngles = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];

  // Helper tính tọa độ (x, y) từ góc và bán kính
  const getCoordinates = (angle: number, r: number) => {
    return {
      x: center + r * Math.cos(angle),
      y: center + r * Math.sin(angle),
    };
  };

  // Tính tọa độ polygon giá trị dữ liệu
  const valuePoints = data.map((item, idx) => {
    const angle = axisAngles[idx % axisAngles.length];
    const clampedScore = Math.min(Math.max(item.averageScore10, 0), maxScore);
    const pointRadius = (clampedScore / maxScore) * radius;
    return getCoordinates(angle, pointRadius);
  });

  const valuePolygonString = valuePoints.map((p) => `${p.x},${p.y}`).join(" ");

  // Vị trí label bên ngoài các đỉnh
  const labelOffsets = [
    { textAnchor: "middle", dy: -12, dx: 0 },   // Top
    { textAnchor: "start", dy: 4, dx: 12 },     // Right
    { textAnchor: "middle", dy: 20, dx: 0 },    // Bottom
    { textAnchor: "end", dy: 4, dx: -12 },      // Left
  ];

  const activeItem = hoveredIndex !== null ? data[hoveredIndex] : null;

  return (
    <div className={`relative flex flex-col items-center justify-center select-none ${className}`}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="overflow-visible"
        aria-label="Biểu đồ radar 4 khối kiến thức học thuật UIT"
      >
        {/* Định nghĩa Gradient đổ bóng cho polygon dữ liệu */}
        <defs>
          <linearGradient id="radarFillGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#6366f1" stopOpacity="0.15" />
          </linearGradient>
          <filter id="glowEffect" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="0" stdDeviation="3" floodColor="#a78bfa" floodOpacity="0.5" />
          </filter>
        </defs>

        {/* 1. Các vòng lưới đa giác (25%, 50%, 75%, 100%) */}
        {gridLevels.map((level, levelIdx) => {
          const levelRadius = level * radius;
          const gridPoints = axisAngles
            .map((angle) => {
              const { x, y } = getCoordinates(angle, levelRadius);
              return `${x},${y}`;
            })
            .join(" ");

          const scoreLabel = (level * maxScore).toFixed(1);

          return (
            <g key={`grid-level-${levelIdx}`}>
              <polygon
                points={gridPoints}
                fill="none"
                stroke="#27272a" /* zinc-800 */
                strokeWidth={level === 1.0 ? "1.5" : "1"}
                strokeDasharray={level === 1.0 ? undefined : "3 3"}
              />
              {/* Nhãn thang điểm dọc theo trục trên */}
              <text
                x={center + 6}
                y={center - levelRadius + 4}
                fill="#71717a" /* zinc-500 */
                fontSize="9"
                fontFamily="monospace"
                className="pointer-events-none"
              >
                {scoreLabel}
              </text>
            </g>
          );
        })}

        {/* 2. Các đường trục hướng tâm */}
        {axisAngles.map((angle, idx) => {
          const { x, y } = getCoordinates(angle, radius);
          return (
            <line
              key={`axis-line-${idx}`}
              x1={center}
              y1={center}
              x2={x}
              y2={y}
              stroke="#3f3f46" /* zinc-700 */
              strokeWidth="1"
            />
          );
        })}

        {/* 3. Đa giác giá trị (Value Polygon) */}
        {data.length >= 3 && (
          <polygon
            points={valuePolygonString}
            fill="url(#radarFillGradient)"
            stroke="#a78bfa" /* violet-400 */
            strokeWidth="2"
            filter="url(#glowEffect)"
            className="transition-all duration-300 ease-out"
          />
        )}

        {/* 4. Các điểm nút (Vertices) và nhãn trục */}
        {data.map((item, idx) => {
          const angle = axisAngles[idx % axisAngles.length];
          const point = valuePoints[idx];
          const outerPoint = getCoordinates(angle, radius);
          const offset = labelOffsets[idx % labelOffsets.length];
          const isHovered = hoveredIndex === idx;

          return (
            <g key={`axis-node-${item.category}`}>
              {/* Vùng tương tác trong suốt mở rộng quanh đỉnh để hover dễ dàng */}
              <circle
                cx={point.x}
                cy={point.y}
                r={16}
                fill="transparent"
                className="cursor-pointer"
                onMouseEnter={() => setHoveredIndex(idx)}
                onMouseLeave={() => setHoveredIndex(null)}
              />

              {/* Điểm đỉnh thực tế */}
              <circle
                cx={point.x}
                cy={point.y}
                r={isHovered ? 6 : 4}
                fill={isHovered ? "#ffffff" : "#c4b5fd"}
                stroke="#7c3aed" /* violet-600 */
                strokeWidth={isHovered ? 2.5 : 1.5}
                className="transition-all duration-200 pointer-events-none"
              />

              {/* Nhãn trục */}
              <text
                x={outerPoint.x + offset.dx}
                y={outerPoint.y + offset.dy}
                textAnchor={offset.textAnchor as "middle" | "start" | "end"}
                fill={isHovered ? "#e4e4e7" : "#a1a1aa"} /* zinc-200 / zinc-400 */
                fontSize={isHovered ? "12" : "11"}
                fontWeight={isHovered ? "600" : "500"}
                className="transition-all duration-150 cursor-pointer"
                onMouseEnter={() => setHoveredIndex(idx)}
                onMouseLeave={() => setHoveredIndex(null)}
              >
                {item.shortLabel}
                <tspan
                  x={outerPoint.x + offset.dx}
                  dy={offset.dy < 0 ? "-1.2em" : "1.2em"}
                  fontSize="10"
                  fill={item.averageScore10 >= 8.0 ? "#34d399" : item.averageScore10 >= 5.0 ? "#a78bfa" : "#f87171"}
                  fontWeight="600"
                >
                  {item.averageScore10 > 0 ? `${item.averageScore10.toFixed(2)}` : "—"}
                </tspan>
              </text>
            </g>
          );
        })}
      </svg>

      {/* 5. Tooltip tương tác hiển thị chi tiết khi hover */}
      {activeItem && (
        <div
          className="absolute z-20 bottom-2 bg-zinc-900/95 border border-violet-500/30 backdrop-blur-md rounded-lg p-2.5 shadow-xl text-xs text-zinc-200 pointer-events-none animate-in fade-in zoom-in-95 duration-150"
          style={{ minWidth: "160px" }}
        >
          <div className="flex items-center justify-between gap-2 border-b border-zinc-800 pb-1.5 mb-1.5">
            <span className="font-semibold text-zinc-100">{activeItem.label}</span>
            <span
              className={`font-mono font-bold px-1.5 py-0.5 rounded text-[11px] ${
                activeItem.averageScore10 >= 8.5
                  ? "bg-emerald-950/60 text-emerald-400 border border-emerald-800/50"
                  : activeItem.averageScore10 >= 7.0
                  ? "bg-violet-950/60 text-violet-400 border border-violet-800/50"
                  : activeItem.averageScore10 >= 5.0
                  ? "bg-amber-950/60 text-amber-400 border border-amber-800/50"
                  : "bg-rose-950/60 text-rose-400 border border-rose-800/50"
              }`}
            >
              {activeItem.averageScore10 > 0 ? `${activeItem.averageScore10.toFixed(2)} / 10` : "Chưa có điểm"}
            </span>
          </div>
          <div className="space-y-1 text-zinc-400">
            <div className="flex justify-between">
              <span>Số môn học:</span>
              <span className="text-zinc-200 font-mono">{activeItem.courseCount} môn</span>
            </div>
            <div className="flex justify-between">
              <span>Tín chỉ đạt:</span>
              <span className="text-zinc-200 font-mono">
                {activeItem.passedCredits} / {activeItem.totalCredits} TC
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
