import React, { useState, useRef, useEffect } from 'react';
import { Boundary, Zone } from '@/lib/mockZones';
import { Button } from '@/components/ui/Button';
import {
  Check,
  X,
  Crosshair,
  Pencil,
  Trash2,
} from 'lucide-react';

export interface ZoneCanvasProps {
  cameraName: string;
  zones: Zone[];
  selectedZoneId: string | null;
  onSelectZone: (id: string | null) => void;
  onEditZone: (zone: Zone) => void;
  onDeleteZone: (id: string) => void;
  isDrawing: boolean;
  onStartDrawing: () => void;
  onCancelDrawing: () => void;
  onFinishDrawing: (points: { x: number; y: number }[]) => void;
  /** The camera's live MJPEG stream (same URL CameraTile uses), so zones are
   * drawn against the real scene instead of a synthetic grid. Optional —
   * falls back to the grid when the camera has no stream or it's offline. */
  streamUrl?: string;
  /** 'line' draws/shows boundaries (2-point tripwires) instead of polygon
   * zones — same canvas, same click-to-place-vertex mechanics, just a
   * different finish threshold and a different shape rendered. */
  mode?: 'polygon' | 'line';
  boundaries?: Boundary[];
  selectedBoundaryId?: string | null;
  onSelectBoundary?: (id: string | null) => void;
  onEditBoundary?: (boundary: Boundary) => void;
  onDeleteBoundary?: (id: string) => void;
}

export const ZoneCanvas: React.FC<ZoneCanvasProps> = ({
  cameraName,
  zones,
  selectedZoneId,
  onSelectZone,
  onEditZone,
  onDeleteZone,
  isDrawing,
  onStartDrawing,
  onCancelDrawing,
  onFinishDrawing,
  streamUrl,
  mode = 'polygon',
  boundaries = [],
  selectedBoundaryId = null,
  onSelectBoundary,
  onEditBoundary,
  onDeleteBoundary,
}) => {
  const [streamFailed, setStreamFailed] = useState(false);
  useEffect(() => setStreamFailed(false), [streamUrl]);
  const minPoints = mode === 'line' ? 2 : 3;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [currentPoints, setCurrentPoints] = useState<{ x: number; y: number }[]>([]);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
  const [hoveredZoneId, setHoveredZoneId] = useState<string | null>(null);

  // SVG dimensions for 16:9 aspect ratio
  const VIEW_WIDTH = 1000;
  const VIEW_HEIGHT = 562.5;

  // Calculate normalized coordinate (0.0 to 1.0) from mouse event
  const getNormalizedCoordinates = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current) return { x: 0, y: 0 };
    const rect = svgRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    return {
      x: Number(x.toFixed(4)),
      y: Number(y.toFixed(4)),
    };
  };

  const handleCanvasClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!isDrawing) return;
    const pt = getNormalizedCoordinates(e);
    // A line only ever needs a start and an end point — finish the moment
    // the second one lands instead of waiting for a double-click, which is
    // an awkward gesture for placing exactly two points.
    if (mode === 'line' && currentPoints.length + 1 >= minPoints) {
      const finished = [...currentPoints, pt];
      onFinishDrawing(finished);
      setCurrentPoints([]);
      return;
    }
    setCurrentPoints((prev) => [...prev, pt]);
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const pt = getNormalizedCoordinates(e);
    setMousePos(pt);
  };

  const handleDoubleClick = () => {
    if (isDrawing && currentPoints.length >= minPoints) {
      handleCompletePolygon();
    }
  };

  const handleCompletePolygon = () => {
    if (currentPoints.length >= minPoints) {
      onFinishDrawing(currentPoints);
      setCurrentPoints([]);
    }
  };

  const handleCancel = () => {
    setCurrentPoints([]);
    onCancelDrawing();
  };

  // Convert normalized points array to SVG polygon points string
  const toSvgPoints = (points: { x: number; y: number }[]) => {
    return points
      .map((p) => `${p.x * VIEW_WIDTH},${p.y * VIEW_HEIGHT}`)
      .join(' ');
  };

  // Compute centroid of polygon for label placement
  const getCentroid = (points: { x: number; y: number }[]) => {
    if (points.length === 0) return { x: 500, y: 281 };
    const sumX = points.reduce((acc, p) => acc + p.x, 0);
    const sumY = points.reduce((acc, p) => acc + p.y, 0);
    return {
      x: (sumX / points.length) * VIEW_WIDTH,
      y: (sumY / points.length) * VIEW_HEIGHT,
    };
  };

  const tierColors = {
    red: {
      fill: 'rgba(229, 72, 77, 0.25)',
      stroke: '#e5484d',
      highlight: '#ff757a',
    },
    yellow: {
      fill: 'rgba(230, 195, 74, 0.25)',
      stroke: '#e6c34a',
      highlight: '#ffdb6b',
    },
    green: {
      fill: 'rgba(79, 191, 122, 0.25)',
      stroke: '#4fbf7a',
      highlight: '#71d498',
    },
  };

  return (
    <div className="space-y-3">
      {/* Editor Canvas Toolbar Overlay */}
      <div className="flex items-center justify-between px-3 py-2 bg-bg-surface border border-border-subtle rounded-sm font-mono text-xs">
        <div className="flex items-center gap-2">
          <Crosshair className="w-4 h-4 text-accent-teal" />
          <span className="text-text-primary font-semibold uppercase">
            {cameraName} // REFERENCE FRAME CANVAS
          </span>
          <span className="text-border-subtle">|</span>
          {mode === 'line' ? (
            <span className="text-accent-teal font-semibold">
              {boundaries.length} {boundaries.length === 1 ? 'BOUNDARY' : 'BOUNDARIES'} DEFINED
            </span>
          ) : zones.length > 0 ? (
            <span className="text-accent-teal font-semibold">
              {zones.length} {zones.length === 1 ? 'ZONE' : 'ZONES'} DEFINED
            </span>
          ) : (
            <span className="text-accent-yellow font-semibold flex items-center gap-1.5 bg-accent-yellow/10 px-2 py-0.5 rounded border border-accent-yellow/30 text-[11px]">
              <span className="w-1.5 h-1.5 rounded-full bg-accent-yellow animate-pulse" />
              AUTONOMOUS DEFAULT POLICY ACTIVE
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          {mousePos && (
            <span className="hidden sm:inline text-text-muted text-[11px]">
              X: {mousePos.x} · Y: {mousePos.y}
            </span>
          )}

          {isDrawing ? (
            <div className="flex items-center gap-2">
              <span className="text-accent-teal font-semibold">
                {currentPoints.length} {mode === 'line' ? 'POINT(S) PLACED' : 'VERTICES PLACED'}
              </span>
              <Button
                variant="primary"
                size="sm"
                disabled={currentPoints.length < minPoints}
                leftIcon={<Check className="w-3.5 h-3.5" />}
                onClick={handleCompletePolygon}
              >
                {mode === 'line' ? 'Finish Boundary' : 'Finish Zone'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<X className="w-3.5 h-3.5" />}
                onClick={handleCancel}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Crosshair className="w-3.5 h-3.5" />}
              onClick={onStartDrawing}
            >
              {mode === 'line' ? 'Draw New Boundary' : 'Draw New Zone'}
            </Button>
          )}
        </div>
      </div>

      {/* Main 16:9 Canvas Area */}
      <div className="relative aspect-video w-full rounded-sm border border-border-subtle bg-bg-primary overflow-hidden select-none">
        {/* Live feed as the drawing reference when available; the
            synthetic grid is only a fallback, not the normal case. */}
        {streamUrl && !streamFailed ? (
          <img
            key={streamUrl}
            src={streamUrl}
            alt={`Live reference frame for ${cameraName}`}
            onError={() => setStreamFailed(true)}
            className="absolute inset-0 w-full h-full object-contain pointer-events-none select-none"
          />
        ) : (
          <div className="absolute inset-0 bg-tactical-grid opacity-40 pointer-events-none" />
        )}

        {/* Tactical Crosshair Watermark — only over the synthetic fallback;
            it would just clutter a real live reference frame. */}
        {(!streamUrl || streamFailed) && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-24 h-24 border border-border-subtle/50 rounded-full flex items-center justify-center">
              <div className="w-1.5 h-1.5 rounded-full bg-accent-teal/40" />
            </div>
          </div>
        )}

        {/* Camera OSD Label */}
        <div className="absolute top-3 left-3 pointer-events-none px-2.5 py-1 bg-bg-surface/80 backdrop-blur-sm border border-border-subtle rounded-sm font-mono text-xs text-accent-teal">
          CAM: {cameraName.toUpperCase()} {streamUrl && !streamFailed ? '· LIVE REF FRAME' : '· NO LIVE FEED'}
        </div>

        {/* Drawing Prompt Banner */}
        {isDrawing && (
          <div className="absolute top-3 right-3 z-30 pointer-events-none px-3 py-1 bg-accent-teal/15 border border-accent-teal/40 text-accent-teal rounded-sm font-mono text-xs animate-pulse">
            {mode === 'line' ? 'CLICK START, THEN END POINT' : 'CLICK TO ADD VERTEX · DOUBLE CLICK TO COMPLETE'}
          </div>
        )}

        {/* SVG Drawing & Polygon Overlay */}
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          className={`absolute inset-0 w-full h-full ${
            isDrawing ? 'cursor-crosshair' : 'cursor-default'
          }`}
          onClick={handleCanvasClick}
          onMouseMove={handleMouseMove}
          onDoubleClick={handleDoubleClick}
        >
          {/* 1. Render Existing Configured Zones (polygon mode only) */}
          {mode === 'polygon' && zones.map((zone) => {
            const colors = tierColors[zone.tier];
            const isSelected = selectedZoneId === zone.id;
            const isHovered = hoveredZoneId === zone.id;
            const centroid = getCentroid(zone.points);

            return (
              <g
                key={zone.id}
                className="transition-all duration-150"
                onMouseEnter={() => !isDrawing && setHoveredZoneId(zone.id)}
                onMouseLeave={() => !isDrawing && setHoveredZoneId(null)}
                onClick={(e) => {
                  if (!isDrawing) {
                    e.stopPropagation();
                    onSelectZone(isSelected ? null : zone.id);
                  }
                }}
              >
                {/* Filled Polygon */}
                <polygon
                  points={toSvgPoints(zone.points)}
                  fill={colors.fill}
                  stroke={isSelected || isHovered ? colors.highlight : colors.stroke}
                  strokeWidth={isSelected || isHovered ? 2.5 : 1.5}
                  strokeDasharray={isSelected ? '6 3' : undefined}
                  className="cursor-pointer transition-colors"
                />

                {/* Vertices indicator dots on hover/select */}
                {(isSelected || isHovered) &&
                  zone.points.map((pt, idx) => (
                    <circle
                      key={idx}
                      cx={pt.x * VIEW_WIDTH}
                      cy={pt.y * VIEW_HEIGHT}
                      r={4}
                      fill={colors.highlight}
                      stroke="#0a0f0d"
                      strokeWidth={1.5}
                    />
                  ))}

                {/* Centered Zone Label */}
                <g transform={`translate(${centroid.x}, ${centroid.y})`}>
                  <rect
                    x="-85"
                    y="-14"
                    width="170"
                    height="28"
                    rx="3"
                    fill="#111917"
                    fillOpacity="0.9"
                    stroke={colors.stroke}
                    strokeWidth="1"
                  />
                  <text
                    x="0"
                    y="4"
                    textAnchor="middle"
                    fill="#e6ece9"
                    fontFamily="Inter, sans-serif"
                    fontSize="11"
                    fontWeight="600"
                  >
                    {zone.label.length > 22
                      ? `${zone.label.substring(0, 20)}...`
                      : zone.label}
                  </text>

                  {/* Direction Vector Indicator for Yellow Zones */}
                  {zone.direction && (
                    <text
                      x="0"
                      y="23"
                      textAnchor="middle"
                      fill={colors.stroke}
                      fontFamily="monospace"
                      fontSize="9"
                      fontWeight="bold"
                    >
                      [{zone.direction.toUpperCase()} VECTOR]
                    </text>
                  )}
                </g>
              </g>
            );
          })}

          {/* 1b. Render Existing Boundaries (line mode only) — a line, not a
              filled region, so it needs its own shape and its own label
              placement (at the midpoint, not a polygon centroid). */}
          {mode === 'line' && boundaries.map((boundary) => {
            const isSelected = selectedBoundaryId === boundary.id;
            const isHovered = hoveredZoneId === boundary.id;
            const x1 = boundary.p1.x * VIEW_WIDTH;
            const y1 = boundary.p1.y * VIEW_HEIGHT;
            const x2 = boundary.p2.x * VIEW_WIDTH;
            const y2 = boundary.p2.y * VIEW_HEIGHT;
            const midX = (x1 + x2) / 2;
            const midY = (y1 + y2) / 2;
            const color = boundary.enabled ? '#5fd6c4' : '#5c6f68';
            const highlight = boundary.enabled ? '#9ff0e3' : '#8fa39b';

            return (
              <g
                key={boundary.id}
                className="transition-all duration-150"
                onMouseEnter={() => !isDrawing && setHoveredZoneId(boundary.id)}
                onMouseLeave={() => !isDrawing && setHoveredZoneId(null)}
                onClick={(e) => {
                  if (!isDrawing) {
                    e.stopPropagation();
                    onSelectBoundary?.(isSelected ? null : boundary.id);
                  }
                }}
              >
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={isSelected || isHovered ? highlight : color}
                  strokeWidth={isSelected || isHovered ? 3 : 2}
                  strokeDasharray={boundary.enabled ? undefined : '6 4'}
                  className="cursor-pointer transition-colors"
                />
                <circle cx={x1} cy={y1} r={4} fill={color} />
                <circle cx={x2} cy={y2} r={4} fill={color} />

                <g transform={`translate(${midX}, ${midY})`}>
                  <rect x="-70" y="-22" width="140" height="20" rx="3" fill="#111917" fillOpacity="0.9" stroke={color} strokeWidth="1" />
                  <text x="0" y="-8" textAnchor="middle" fill="#e6ece9" fontFamily="Inter, sans-serif" fontSize="10" fontWeight="600">
                    {boundary.label.length > 20 ? `${boundary.label.substring(0, 18)}...` : boundary.label || 'Untitled boundary'}
                    {!boundary.enabled && ' (disabled)'}
                  </text>
                </g>
              </g>
            );
          })}

          {/* 2. Render In-Progress Polygon While Drawing */}
          {isDrawing && currentPoints.length > 0 && (
            <g>
              {/* Completed edges so far */}
              <polyline
                points={toSvgPoints(currentPoints)}
                fill="none"
                stroke="#5fd6c4"
                strokeWidth="2"
                strokeDasharray="4 2"
              />

              {/* Dynamic guide line from last vertex to current mouse cursor */}
              {mousePos && (
                <line
                  x1={currentPoints[currentPoints.length - 1].x * VIEW_WIDTH}
                  y1={currentPoints[currentPoints.length - 1].y * VIEW_HEIGHT}
                  x2={mousePos.x * VIEW_WIDTH}
                  y2={mousePos.y * VIEW_HEIGHT}
                  stroke="#5fd6c4"
                  strokeWidth="1.5"
                  strokeDasharray="2 2"
                />
              )}

              {/* Loop closing indicator line if >= 3 points */}
              {mousePos && currentPoints.length >= 3 && (
                <line
                  x1={mousePos.x * VIEW_WIDTH}
                  y1={mousePos.y * VIEW_HEIGHT}
                  x2={currentPoints[0].x * VIEW_WIDTH}
                  y2={currentPoints[0].y * VIEW_HEIGHT}
                  stroke="#5c6f68"
                  strokeWidth="1"
                  strokeDasharray="4 4"
                />
              )}

              {/* Placed Vertex Dots */}
              {currentPoints.map((pt, idx) => (
                <g key={idx}>
                  <circle
                    cx={pt.x * VIEW_WIDTH}
                    cy={pt.y * VIEW_HEIGHT}
                    r={5}
                    fill="#5fd6c4"
                    stroke="#0a0f0d"
                    strokeWidth={2}
                  />
                  <text
                    x={pt.x * VIEW_WIDTH + 8}
                    y={pt.y * VIEW_HEIGHT + 4}
                    fill="#5fd6c4"
                    fontFamily="monospace"
                    fontSize="10"
                    fontWeight="bold"
                  >
                    P{idx + 1}
                  </text>
                </g>
              ))}
            </g>
          )}
        </svg>

        {/* Tactical Autonomous Policy Watermark when 0 Zones defined */}
        {mode === 'polygon' && zones.length === 0 && !isDrawing && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none p-6 text-center">
            <div className="p-4 rounded-2xl bg-bg-elevated border border-ink/10 backdrop-blur-md shadow-2xl max-w-sm space-y-2 text-left pointer-events-auto">
              <div className="flex items-center justify-between border-b border-ink/10 pb-1.5">
                <span className="font-mono text-xs font-bold text-accent-yellow flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-accent-yellow animate-pulse" />
                  AUTONOMOUS THREAT POLICY
                </span>
                <span className="text-[10px] font-mono text-text-muted">ZERO ZONES</span>
              </div>
              <p className="text-[11px] text-text-dim leading-relaxed">
                Drawing custom zones is strictly optional. The autonomous AI matrix monitors this camera automatically:
              </p>
              <div className="flex items-center justify-between pt-1 font-mono text-[10px] bg-ink/[0.03] p-2 rounded-lg border border-ink/5">
                <span className="text-accent-yellow font-semibold">DAY: Caution (Tier 2)</span>
                <span className="text-text-primary/20">•</span>
                <span className="text-accent-red font-semibold">CURFEW: Critical (Tier 1)</span>
              </div>
            </div>
          </div>
        )}

        {/* Hover Action Popover near selected/hovered zone or boundary */}
        {hoveredZoneId && !isDrawing && (
          <div className="absolute bottom-3 right-3 z-30 flex items-center gap-1.5 p-1.5 bg-bg-surface/95 backdrop-blur-sm border border-border-subtle rounded-sm shadow-xl">
            {(() => {
              if (mode === 'line') {
                const boundary = boundaries.find((b) => b.id === hoveredZoneId);
                if (!boundary) return null;
                return (
                  <>
                    <span className="font-mono text-xs text-text-dim px-2">
                      {boundary.label || 'Untitled boundary'}
                    </span>
                    <button
                      onClick={() => onEditBoundary?.(boundary)}
                      title="Edit boundary"
                      className="p-1 rounded-sm text-text-muted hover:text-accent-teal hover:bg-bg-elevated transition-colors"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => onDeleteBoundary?.(boundary.id)}
                      title="Delete boundary"
                      className="p-1 rounded-sm text-text-muted hover:text-accent-red hover:bg-bg-elevated transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </>
                );
              }
              const zone = zones.find((z) => z.id === hoveredZoneId);
              if (!zone) return null;
              return (
                <>
                  <span className="font-mono text-xs text-text-dim px-2">
                    {zone.label}
                  </span>
                  <button
                    onClick={() => onEditZone(zone)}
                    title="Edit zone metadata"
                    className="p-1 rounded-sm text-text-muted hover:text-accent-teal hover:bg-bg-elevated transition-colors"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => onDeleteZone(zone.id)}
                    title="Delete zone"
                    className="p-1 rounded-sm text-text-muted hover:text-accent-red hover:bg-bg-elevated transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
};
