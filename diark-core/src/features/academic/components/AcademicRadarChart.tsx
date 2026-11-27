import React, { useState } from "react";
import type { CategoryAxisData } from "../utils/forecastEngine";

interface AcademicRadarChartProps {
  data: CategoryAxisData[];
  size?: number;
  className?: string;
}

/**
 * Pure SVG Academic Radar Chart (4 Trục kiến thức UIT).
 */
export const AcademicRadarChart: React.FC<AcademicRadarChartProps> = ({
  data,
  size = 320,
  className = "",
}) => {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const center = size / 2;
  const radius = (size / 2) * 0.72;
  const gridLevels = [0.25, 0.5, 0.75, 1.0];
  const maxScore = 10.0;

  // Top, Right, Bottom, Left
  const axisAngles = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];

  const getCoordinates = (angle: number, r: number) => {
    return {
      x: center + r * Math.cos(angle),
      y: center + r * Math.sin(angle),
    };
  };

  const valuePoints = data.map((item, idx) => {
    const angle = axisAngles[idx % axisAngles.length];
    const clampedScore = Math.min(Math.max(item.averageScore10, 0), maxScore);
    const pointRadius = (clampedScore / maxScore) * radius;
    return getCoordinates(angle, pointRadius);
  });

  const valuePolygonString = valuePoints.map((p) => `${p.x},${p.y}`).join(" ");

  const baselinePoints = axisAngles.map((angle) =>
    getCoordinates(angle, (8.5 / maxScore) * radius)
  );
  const baselinePolygonString = baselinePoints.map((p) => `${p.x},${p.y}`).join(" ");

  const labelOffsets = [
    { textAnchor: "middle", dy: -14, dx: 0 }, // Top
    { textAnchor: "start", dy: 4, dx: 14 }, // Right
    { textAnchor: "middle", dy: 24, dx: 0 }, // Bottom
    { textAnchor: "end", dy: 4, dx: -14 }, // Left
  ];

  const activeItem = hoveredIndex !== null ? data[hoveredIndex] : null;

  // Neo tooltip lệch sang góc trống để không bao giờ che nhãn trục (đặc biệt là trục dưới "Chuyên ngành")
  const tooltipCornerClass =
    hoveredIndex === 0
      ? "bottom-1 right-0"
      : hoveredIndex === 1
      ? "top-1 left-0"
      : "top-1 right-0";

  return (
    <div className={`relative flex flex-col items-center justify-center select-none ${className}`}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="overflow-visible"
        aria-label="Biểu đồ radar 4 khối kiến thức học thuật UIT"
      >
        <defs>
          <linearGradient id="radarFillGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#2F6BFF" stopOpacity="0.42" />
            <stop offset="100%" stopColor="#6B9BFF" stopOpacity="0.14" />
          </linearGradient>
          <filter id="glowEffect" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="0" stdDeviation="3" floodColor="#2F6BFF" floodOpacity="0.45" />
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
                stroke="#1D263B"
                strokeWidth={level === 1.0 ? "1.5" : "1"}
                strokeDasharray={level === 1.0 ? undefined : "3 3"}
              />
              <text
                x={center + 6}
                y={center - levelRadius + 4}
                fill="#64748b"
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
              stroke="#27344f"
              strokeWidth="1"
            />
          );
        })}

        {/* 2.5 Đa giác chuẩn CTĐT tham chiếu (Target Baseline: 8.5) */}
        <polygon
          points={baselinePolygonString}
          fill="#2F6BFF"
          fillOpacity="0.04"
          stroke="#6B9BFF"
          strokeOpacity="0.32"
          strokeWidth="1.2"
          strokeDasharray="4 4"
          className="pointer-events-none"
        />

        {/* 3. Đa giác giá trị */}
        {data.length >= 3 && (
          <polygon
            points={valuePolygonString}
            fill="url(#radarFillGradient)"
            stroke="#6B9BFF"
            strokeWidth="2"
            filter="url(#glowEffect)"
            className="transition-colors duration-300 ease-out"
          />
        )}

        {/* 4. Các điểm nút (Vertices) và nhãn trục */}
        {data.map((item, idx) => {
          const angle = axisAngles[idx % axisAngles.length];
          const point = valuePoints[idx];
          const outerPoint = getCoordinates(angle, radius);
          const offset = labelOffsets[idx % labelOffsets.length];
          const isHovered = hoveredIndex === idx;
          const hasScore = item.averageScore10 > 0;

          return (
            <g key={`axis-node-${item.category}`}>
              <circle
                cx={point.x}
                cy={point.y}
                r={16}
                fill="transparent"
                className="cursor-pointer"
                onMouseEnter={() => setHoveredIndex(idx)}
                onMouseLeave={() => setHoveredIndex(null)}
              />

              <circle
                cx={point.x}
                cy={point.y}
                r={isHovered ? 6 : hasScore ? 4 : 3}
                fill={isHovered ? "#ffffff" : hasScore ? "#6B9BFF" : "#475569"}
                stroke={hasScore ? "#2F6BFF" : "#334155"}
                strokeWidth={isHovered ? 2.5 : 1.5}
                className="pointer-events-none transition-colors duration-200"
              />

              <text
                x={outerPoint.x + offset.dx}
                y={outerPoint.y + offset.dy}
                textAnchor={offset.textAnchor as "middle" | "start" | "end"}
                fill={isHovered ? "#f8fafc" : hasScore ? "#cbd5e1" : "#64748b"}
                fontSize={isHovered ? "12" : "11"}
                fontWeight={isHovered ? "600" : "500"}
                className="cursor-pointer transition-colors duration-150"
                onMouseEnter={() => setHoveredIndex(idx)}
                onMouseLeave={() => setHoveredIndex(null)}
              >
                {item.shortLabel}
                <tspan
                  x={outerPoint.x + offset.dx}
                  dy={offset.dy < 0 ? "-1.2em" : "1.2em"}
                  fontSize="10"
                  fill={
                    hasScore
                      ? item.averageScore10 >= 8.0
                        ? "#34d399"
                        : item.averageScore10 >= 5.0
                        ? "#6B9BFF"
                        : "#f87171"
                      : "#64748b"
                  }
                  fontWeight={hasScore ? "600" : "normal"}
                >
                  {hasScore ? item.averageScore10.toFixed(2) : "(Chưa tích lũy)"}
                </tspan>
              </text>
            </g>
          );
        })}
      </svg>

      {/* 5. Tooltip tĩnh không blur, neo lệch góc để không che nhãn trục */}
      {activeItem && (
        <div
          className={`uit-modal-in pointer-events-none absolute z-20 ${tooltipCornerClass} rounded-lg border border-[#1D263B] bg-[#0F1420] p-2.5 text-xs text-zinc-200 shadow-2xl`}
          style={{ minWidth: "165px" }}
        >
          <div className="mb-1.5 flex items-center justify-between gap-2 border-b border-[#1D263B] pb-1.5">
            <span className="font-semibold text-zinc-100">{activeItem.label}</span>
            <span
              className={`rounded border px-1.5 py-0.5 font-mono text-[11px] font-bold ${
                activeItem.averageScore10 >= 8.0
                  ? "border-emerald-500/30 bg-emerald-950/60 text-emerald-400"
                  : activeItem.averageScore10 >= 5.0
                  ? "border-[#2F6BFF]/35 bg-[#2F6BFF]/[0.16] text-[#6B9BFF]"
                  : "border-rose-500/30 bg-rose-950/60 text-rose-400"
              }`}
            >
              {activeItem.averageScore10 > 0 ? `${activeItem.averageScore10.toFixed(2)} / 10` : "Chưa có điểm"}
            </span>
          </div>
          <div className="space-y-1 text-zinc-400">
            <div className="flex justify-between">
              <span>Số môn học:</span>
              <span className="font-mono text-zinc-200">{activeItem.courseCount} môn</span>
            </div>
            <div className="flex justify-between">
              <span>Tín chỉ đạt:</span>
              <span className="font-mono text-zinc-200">
                {activeItem.passedCredits} / {activeItem.totalCredits} TC
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
