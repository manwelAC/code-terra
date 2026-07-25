"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import WalkModeScene, { type WalkModePosition } from "@/components/WalkModeScene";
import {
  compactNumber,
  getLanguageFilters,
  languageCount,
  languageColor,
  repositoryHasLanguage,
  type LanguageFilter,
  type TerrainRepository,
} from "@/lib/repositories";

type TerrainCanvasProps = {
  repositories: TerrainRepository[];
  selectedId: string;
  year: number;
  language: LanguageFilter;
  zoom: number;
  isImmersive: boolean;
  mapKeyOpen: boolean;
  onSelect: (id: string) => void;
  onYearChange: (year: number) => void;
  onZoomChange: (zoom: number) => void;
  onLanguageChange: (language: LanguageFilter) => void;
  onImmersiveChange: (isImmersive: boolean) => void;
  onToggleMapKey: () => void;
  onCloseMapKey: () => void;
  onLogout?: () => void;
  isLoggingOut?: boolean;
};

type Size = { width: number; height: number };
type Point = { x: number; y: number };
type TerrainPosition = { px: number; py: number; labelY: number };
type TerrainLayout = Record<string, TerrainPosition>;
type TerrainGeometry = ReturnType<typeof terrainGeometry>;
type MountainSprite = {
  canvas: HTMLCanvasElement;
  left: number;
  top: number;
  width: number;
  height: number;
};
type DrawTerrainSceneOptions = {
  transition?: boolean;
};
type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  origin: Point;
  moved: boolean;
  mode: "pan" | "terrain";
  repositoryId?: string;
  terrainOrigin?: TerrainPosition;
  terrainWasCustomized?: boolean;
};
type AtlasMode = "terra" | "timeline" | "walk";

const labelNumber = (value: number) => String(value + 1).padStart(2, "0");
const MIN_ZOOM = 80;
const MAX_ZOOM = 280;
const WALK_ENTRY_ZOOM = 280;
const TERRAIN_LAYOUT_STORAGE_KEY = "code-terra:terrain-layout:v1";
const SPRITE_ZOOM_STEP = 5;
const TRANSITION_SPRITE_ZOOM_STEP = 20;
const TRANSITION_MAX_SPRITE_ZOOM = 180;
const WALK_MODE_MOUNT_DELAY_MS = 220;
const WALK_MODE_MIN_LOADING_MS = 1120;
const MAX_MOUNTAIN_SPRITES = 320;
const mountainSpriteCache = new Map<string, MountainSprite>();

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function randomTerrainPhase() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return (values[0] / 0xffffffff) * Math.PI * 2;
}

function terrainLabelY(repository: TerrainRepository, py: number) {
  return clamp(py - (repository.py - repository.labelY), 0.05, 0.95);
}

function terrainArrangementGrowth(repository: TerrainRepository, year: number) {
  return Math.min(1, 0.48 + (year - repository.created) * 0.13);
}

function terrainArrangementRadius(repository: TerrainRepository, year: number) {
  const growth = terrainArrangementGrowth(repository, year);
  return clamp(0.035 + repository.spread * growth * 0.04 + repository.relief * 0.018, 0.052, 0.112);
}

function layoutDistance(a: { px: number; py: number }, b: { px: number; py: number }) {
  return Math.hypot(a.px - b.px, (a.py - b.py) * 1.16);
}

function createTerrainArrangement(repositories: TerrainRepository[], year: number) {
  const count = Math.max(1, repositories.length);
  const phase = randomTerrainPhase();
  const placed: Array<TerrainPosition & { id: string; radius: number }> = [];
  const sortedRepositories = [...repositories].sort((a, b) => {
    const radiusDifference = terrainArrangementRadius(b, year) - terrainArrangementRadius(a, year);
    return radiusDifference || b.lines - a.lines || a.seed - b.seed;
  });
  const candidateCount = Math.max(220, count * 18);
  const spacingFactor = clamp(1.42 - count * 0.006, 1.04, 1.32);

  sortedRepositories.forEach((repository, repositoryIndex) => {
    const radius = terrainArrangementRadius(repository, year);
    const edgeX = clamp(0.06 + radius * 0.56, 0.07, 0.16);
    const edgeY = clamp(0.1 + radius * 0.52, 0.11, 0.18);
    let bestPosition = { px: 0.5, py: 0.5 };
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex += 1) {
      const candidatePhase = phase + repository.seed * 0.013 + candidateIndex * 2.399963;
      const ringProgress = ((candidateIndex * 0.61803398875 + repositoryIndex * 0.173) % 1);
      const radial = Math.sqrt(ringProgress);
      const wobble = seededNoise(repository.seed, candidateIndex, repositoryIndex) * 0.026;
      const px = clamp(0.5 + Math.cos(candidatePhase) * radial * 0.47 + wobble, edgeX, 1 - edgeX);
      const py = clamp(0.51 + Math.sin(candidatePhase) * radial * 0.36 + wobble * 0.7, edgeY, 1 - edgeY);
      const centerBias = Math.hypot(px - 0.5, (py - 0.51) * 1.28) * 0.045;
      const spacingScore = placed.length
        ? Math.min(...placed.map((position) => {
          const desired = (radius + position.radius) * spacingFactor + 0.035;
          return layoutDistance({ px, py }, position) - desired;
        }))
        : 1;
      const score = spacingScore - centerBias + seededNoise(repository.seed, candidateIndex, 19) * 0.002;

      if (score > bestScore) {
        bestScore = score;
        bestPosition = { px, py };
      }
    }

    placed.push({
      id: repository.id,
      radius,
      px: bestPosition.px,
      py: bestPosition.py,
      labelY: terrainLabelY(repository, bestPosition.py),
    });
  });

  for (let iteration = 0; iteration < 90; iteration += 1) {
    for (let index = 0; index < placed.length; index += 1) {
      for (let nextIndex = index + 1; nextIndex < placed.length; nextIndex += 1) {
        const current = placed[index];
        const next = placed[nextIndex];
        const desired = (current.radius + next.radius) * spacingFactor + 0.03;
        const dx = next.px - current.px;
        const dy = (next.py - current.py) * 1.16;
        const distance = Math.max(0.0001, Math.hypot(dx, dy));
        if (distance >= desired) continue;
        const push = (desired - distance) * 0.018;
        const pushX = (dx / distance) * push;
        const pushY = ((dy / distance) * push) / 1.16;
        current.px -= pushX;
        current.py -= pushY;
        next.px += pushX;
        next.py += pushY;
      }
    }

    placed.forEach((position) => {
      const edgeX = clamp(0.06 + position.radius * 0.56, 0.07, 0.16);
      const edgeY = clamp(0.1 + position.radius * 0.52, 0.11, 0.18);
      position.px = clamp(position.px, edgeX, 1 - edgeX);
      position.py = clamp(position.py, edgeY, 1 - edgeY);
    });
  }

  return Object.fromEntries(placed.map((position) => {
    const repository = repositories.find((item) => item.id === position.id);
    return [
      position.id,
      {
        px: position.px,
        py: position.py,
        labelY: repository ? terrainLabelY(repository, position.py) : position.labelY,
      },
    ];
  }));
}

function seededNoise(seed: number, angleIndex: number, ring: number) {
  const value = Math.sin(seed * 91.73 + angleIndex * 17.17 + ring * 43.11) * 43758.5453;
  return (value - Math.floor(value)) * 2 - 1;
}

function hexToRgb(hex: string) {
  const color = hex.replace("#", "");
  return {
    r: Number.parseInt(color.slice(0, 2), 16),
    g: Number.parseInt(color.slice(2, 4), 16),
    b: Number.parseInt(color.slice(4, 6), 16),
  };
}

function colorWithAlpha(hex: string, alpha: number) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function terrainGeometry(
  repository: TerrainRepository,
  size: Size,
  zoom: number,
  year: number,
  pan: Point,
) {
  const scale = zoom / 100;
  const minDimension = Math.min(size.width, size.height);
  const growth = Math.min(1, 0.48 + (year - repository.created) * 0.13);
  const centerX = size.width / 2 + (repository.px * size.width - size.width / 2) * scale + pan.x;
  const centerY = size.height / 2 + (repository.py * size.height - size.height / 2) * scale + pan.y;
  const radiusX = minDimension * 0.125 * repository.spread * growth * scale;
  const radiusY = radiusX * 0.46;
  const height = minDimension * 0.13 * repository.relief * growth * scale;
  return { centerX, centerY, radiusX, radiusY, height, growth };
}

function drawMountain(
  context: CanvasRenderingContext2D,
  repository: TerrainRepository,
  size: Size,
  zoom: number,
  year: number,
  pan: Point,
  selected: boolean,
  dimmed: boolean,
  geometryOverride?: TerrainGeometry,
) {
  const { centerX, centerY, radiusX, radiusY, height } = geometryOverride ?? terrainGeometry(
    repository, size, zoom, year, pan,
  );
  const opacity = dimmed ? 0.13 : selected ? 1 : 0.64;
  const segments = 40;
  const ringCount = repository.commitCountAvailable
    ? Math.max(7, Math.min(18, Math.round(7 + Math.log10(repository.commits + 1) * 3.2)))
    : 8;
  const rings: Point[][] = [];

  context.save();
  context.globalCompositeOperation = "lighter";
  const halo = context.createRadialGradient(centerX, centerY - height * 0.16, 0, centerX, centerY, radiusX * 1.35);
  halo.addColorStop(0, colorWithAlpha(repository.color, 0.15 * opacity));
  halo.addColorStop(0.6, colorWithAlpha(repository.color, 0.045 * opacity));
  halo.addColorStop(1, colorWithAlpha(repository.color, 0));
  context.fillStyle = halo;
  context.fillRect(centerX - radiusX * 1.45, centerY - height - radiusY, radiusX * 2.9, height + radiusY * 2.3);
  context.restore();

  for (let ring = 0; ring <= ringCount; ring += 1) {
    const fraction = ring / ringCount;
    const elevation = height * Math.pow(1 - fraction, 1.45);
    const points: Point[] = [];
    for (let segment = 0; segment < segments; segment += 1) {
      const angle = (segment / segments) * Math.PI * 2;
      const edgeNoise = 1 + seededNoise(repository.seed, segment, ring) * (0.025 + fraction * 0.06);
      points.push({
        x: centerX + Math.cos(angle) * radiusX * fraction * edgeNoise,
        y: centerY + Math.sin(angle) * radiusY * fraction * edgeNoise - elevation,
      });
    }
    rings.push(points);
  }

  for (let ring = ringCount - 1; ring >= 0; ring -= 1) {
    const inner = rings[ring];
    const outer = rings[ring + 1];
    for (let segment = 0; segment < segments; segment += 1) {
      const next = (segment + 1) % segments;
      const direction = Math.cos((segment / segments) * Math.PI * 2 - 0.7);
      const light = 0.12 + (direction + 1) * 0.09 + (1 - ring / ringCount) * 0.06;
      context.beginPath();
      context.moveTo(inner[segment].x, inner[segment].y);
      context.lineTo(inner[next].x, inner[next].y);
      context.lineTo(outer[next].x, outer[next].y);
      context.lineTo(outer[segment].x, outer[segment].y);
      context.closePath();
      context.fillStyle = colorWithAlpha(repository.color, light * opacity);
      context.fill();
    }
  }

  context.save();
  context.globalAlpha = opacity;
  for (let ring = 2; ring <= ringCount; ring += selected ? 2 : 3) {
    const points = rings[ring];
    context.beginPath();
    points.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    context.closePath();
    context.strokeStyle = colorWithAlpha(repository.color, selected ? 0.67 : 0.35);
    context.lineWidth = selected ? 1 : 0.7;
    context.stroke();
  }

  for (let segment = 0; segment < segments; segment += 8) {
    context.beginPath();
    for (let ring = 0; ring <= ringCount; ring += 1) {
      const point = rings[ring][segment];
      if (ring === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    }
    context.strokeStyle = colorWithAlpha(repository.color, selected ? 0.28 : 0.12);
    context.lineWidth = 0.65;
    context.stroke();
  }

  for (let ground = 1; ground <= 6; ground += 1) {
    const multiplier = 1 + ground * 0.11;
    context.beginPath();
    for (let segment = 0; segment <= segments; segment += 1) {
      const angle = (segment / segments) * Math.PI * 2;
      const noise = 1 + seededNoise(repository.seed + ground, segment % segments, ground) * 0.035;
      const x = centerX + Math.cos(angle) * radiusX * multiplier * noise;
      const y = centerY + Math.sin(angle) * radiusY * multiplier * noise;
      if (segment === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.strokeStyle = colorWithAlpha(repository.color, (selected ? 0.22 : 0.1) / ground);
    context.lineWidth = 0.7;
    context.stroke();
  }
  context.restore();

  if (selected && !dimmed) {
    const summit = rings[0][0];
    context.save();
    context.shadowColor = repository.color;
    context.shadowBlur = 12;
    context.fillStyle = "#ffffff";
    context.beginPath();
    context.arc(summit.x, summit.y, 2.2, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }
}

function trimMountainSpriteCache() {
  while (mountainSpriteCache.size > MAX_MOUNTAIN_SPRITES) {
    const oldestKey = mountainSpriteCache.keys().next().value;
    if (oldestKey === undefined) break;
    mountainSpriteCache.delete(oldestKey);
  }
}

function drawCachedMountain(
  context: CanvasRenderingContext2D,
  repository: TerrainRepository,
  geometry: TerrainGeometry,
  spriteGeometry: TerrainGeometry,
  size: Size,
  zoom: number,
  year: number,
  pan: Point,
  selected: boolean,
  dimmed: boolean,
  dpr: number,
) {
  const { radiusX, radiusY, height } = spriteGeometry;
  const key = [
    repository.id,
    repository.color,
    repository.commits,
    Math.round(radiusX * 10),
    Math.round(height * 10),
    selected ? 1 : 0,
    dimmed ? 1 : 0,
    dpr,
  ].join(":");
  let sprite = mountainSpriteCache.get(key);

  if (!sprite) {
    const left = -radiusX * 1.75;
    const top = -height - radiusY * 1.45;
    const width = radiusX * 3.5;
    const spriteHeight = height + radiusY * 3.2;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(width * dpr));
    canvas.height = Math.max(1, Math.ceil(spriteHeight * dpr));
    const spriteContext = canvas.getContext("2d");

    if (!spriteContext) return;
    spriteContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawMountain(
      spriteContext,
      repository,
      size,
      zoom,
      year,
      pan,
      selected,
      dimmed,
      {
        ...spriteGeometry,
        centerX: -left,
        centerY: -top,
      },
    );
    sprite = { canvas, left, top, width, height: spriteHeight };
    mountainSpriteCache.set(key, sprite);
    trimMountainSpriteCache();
  } else {
    mountainSpriteCache.delete(key);
    mountainSpriteCache.set(key, sprite);
  }

  const scale = geometry.radiusX / Math.max(1, spriteGeometry.radiusX);
  context.drawImage(
    sprite.canvas,
    geometry.centerX + sprite.left * scale,
    geometry.centerY + sprite.top * scale,
    sprite.width * scale,
    sprite.height * scale,
  );
}

function drawTerrainScene(
  context: CanvasRenderingContext2D,
  repositories: TerrainRepository[],
  selectedId: string,
  size: Size,
  zoom: number,
  year: number,
  language: LanguageFilter,
  pan: Point,
  dpr: number,
  options: DrawTerrainSceneOptions = {},
) {
  const transition = options.transition ?? false;
  context.clearRect(0, 0, size.width, size.height);
  context.fillStyle = "#07110d";
  context.fillRect(0, 0, size.width, size.height);

  const centerGlow = context.createRadialGradient(
    size.width * 0.5,
    size.height * 0.46,
    0,
    size.width * 0.5,
    size.height * 0.46,
    Math.max(size.width, size.height) * 0.62,
  );
  centerGlow.addColorStop(0, "rgba(216,245,106,0.06)");
  centerGlow.addColorStop(1, "rgba(216,245,106,0)");
  context.fillStyle = centerGlow;
  context.fillRect(0, 0, size.width, size.height);

  context.strokeStyle = "rgba(188,222,190,0.055)";
  context.lineWidth = 0.55;
  const gridSize = transition ? 88 : 44;
  const gridOffsetX = ((pan.x % gridSize) + gridSize) % gridSize;
  const gridOffsetY = ((pan.y % gridSize) + gridSize) % gridSize;
  for (let x = gridOffsetX - gridSize; x <= size.width + gridSize; x += gridSize) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, size.height);
    context.stroke();
  }
  for (let y = gridOffsetY - gridSize; y <= size.height + gridSize; y += gridSize) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(size.width, y);
    context.stroke();
  }

  for (let line = 0; line < (transition ? 6 : 12); line += 1) {
    context.beginPath();
    for (let x = -20; x <= size.width + 20; x += transition ? 18 : 8) {
      const baseline = 28 + line * (size.height / 10.5) + pan.y * 0.12;
      const terrainX = x - pan.x;
      const y = baseline + Math.sin(terrainX * 0.012 + line * 0.9) * 8 + Math.sin(terrainX * 0.026 - line) * 3;
      if (x === -20) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.strokeStyle = "rgba(216,245,106,0.035)";
    context.lineWidth = 0.65;
    context.stroke();
  }

  const routeRepositories = transition ? [] : repositories
    .filter((repository) => repositoryHasLanguage(repository, language))
    .sort((a, b) => a.created - b.created || a.seed - b.seed);

  context.save();
  routeRepositories.slice(0, -1).forEach((repository, index) => {
    const nextRepository = routeRepositories[index + 1];
    const from = terrainGeometry(repository, size, zoom, year, pan);
    const to = terrainGeometry(nextRepository, size, zoom, year, pan);
    const selectedRoute = repository.id === selectedId || nextRepository.id === selectedId;
    const midpointX = (from.centerX + to.centerX) / 2;
    const midpointY = (from.centerY + to.centerY) / 2;
    const dx = to.centerX - from.centerX;
    const dy = to.centerY - from.centerY;
    const curve = Math.min(52, Math.hypot(dx, dy) * 0.13) * (index % 2 === 0 ? 1 : -1);

    context.beginPath();
    context.moveTo(from.centerX, from.centerY);
    context.quadraticCurveTo(
      midpointX - (dy / Math.max(1, Math.hypot(dx, dy))) * curve,
      midpointY + (dx / Math.max(1, Math.hypot(dx, dy))) * curve,
      to.centerX,
      to.centerY,
    );
    context.setLineDash(selectedRoute ? [2, 5] : [2, 8]);
    context.lineDashOffset = index * 2;
    context.strokeStyle = selectedRoute
      ? "rgba(216,245,106,0.34)"
      : "rgba(188,222,190,0.105)";
    context.lineWidth = selectedRoute ? 1.05 : 0.7;
    context.stroke();
  });
  context.setLineDash([]);
  routeRepositories.forEach((repository) => {
    const point = terrainGeometry(repository, size, zoom, year, pan);
    context.beginPath();
    context.arc(point.centerX, point.centerY, repository.id === selectedId ? 2.2 : 1.25, 0, Math.PI * 2);
    context.fillStyle = repository.id === selectedId
      ? colorWithAlpha(repository.color, 0.9)
      : "rgba(188,222,190,0.22)";
    context.fill();
  });
  context.restore();

  [...repositories]
    .sort((a, b) => a.py - b.py)
    .forEach((repository) => {
      const geometry = terrainGeometry(repository, size, zoom, year, pan);
      const drawMargin = Math.max(geometry.radiusX, geometry.height) * 1.7;
      if (
        geometry.centerX + drawMargin < 0
        || geometry.centerX - drawMargin > size.width
        || geometry.centerY + drawMargin < 0
        || geometry.centerY - geometry.height - drawMargin > size.height
      ) return;
      const selected = repository.id === selectedId;
      const dimmed = !repositoryHasLanguage(repository, language);
      const spriteStep = transition ? TRANSITION_SPRITE_ZOOM_STEP : SPRITE_ZOOM_STEP;
      const cappedZoom = transition ? Math.min(TRANSITION_MAX_SPRITE_ZOOM, zoom) : zoom;
      const spriteZoom = Math.round(cappedZoom / spriteStep) * spriteStep;
      const spriteGeometry = terrainGeometry(repository, size, Math.max(MIN_ZOOM, spriteZoom), year, { x: 0, y: 0 });
      drawCachedMountain(
        context,
        repository,
        geometry,
        spriteGeometry,
        size,
        zoom,
        year,
        pan,
        selected,
        dimmed,
        dpr,
      );
    });
}

export default function TerrainCanvas({
  repositories,
  selectedId,
  year,
  language,
  zoom,
  isImmersive,
  mapKeyOpen,
  onSelect,
  onYearChange,
  onZoomChange,
  onLanguageChange,
  onImmersiveChange,
  onToggleMapKey,
  onCloseMapKey,
  onLogout,
  isLoggingOut = false,
}: TerrainCanvasProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const panFrameRef = useRef<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const renderedPanRef = useRef<Point>({ x: 0, y: 0 });
  const skipTransitionRef = useRef(false);
  const walkReturnViewRef = useRef<{ pan: Point; zoom: number } | null>(null);
  const walkLoadingStartedAtRef = useRef(0);
  const walkMountTimeoutRef = useRef<number | null>(null);
  const walkReadyTimeoutRef = useRef<number | null>(null);
  const [size, setSize] = useState<Size>({ width: 900, height: 642 });
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [isNavigating, setIsNavigating] = useState(false);
  const [isArranging, setIsArranging] = useState(false);
  const [isWalkTransitioning, setIsWalkTransitioning] = useState(false);
  const [isWalkModeLoading, setIsWalkModeLoading] = useState(false);
  const [isWalkModeSettling, setIsWalkModeSettling] = useState(false);
  const [atlasTransitionLabel, setAtlasTransitionLabel] = useState<string | null>(null);
  const [atlasMode, setAtlasMode] = useState<AtlasMode>("terra");
  const [armedRepositoryId, setArmedRepositoryId] = useState<string | null>(null);
  const [detailsRepositoryId, setDetailsRepositoryId] = useState<string | null>(null);
  const [lastWalkPosition, setLastWalkPosition] = useState<WalkModePosition | null>(null);
  const [positionOverrides, setPositionOverrides] = useState<TerrainLayout>({});
  const positionOverridesRef = useRef<TerrainLayout>({});
  const interactionPanRef = useRef<Point>(pan);
  const interactionZoomRef = useRef(zoom);

  useEffect(() => {
    let frameId: number | null = null;
    try {
      const storedLayout = window.localStorage.getItem(TERRAIN_LAYOUT_STORAGE_KEY);
      if (!storedLayout) return;
      const parsed = JSON.parse(storedLayout) as Record<string, Partial<TerrainPosition>>;
      const validLayout = Object.fromEntries(
        Object.entries(parsed).flatMap(([repositoryId, position]) => {
          const repository = repositories.find((item) => item.id === repositoryId);
          if (!repository || !Number.isFinite(position?.px) || !Number.isFinite(position?.py)) return [];
          const px = Number(position.px);
          const py = Number(position.py);
          const labelY = Number(position.labelY);
          return [[
            repositoryId,
            {
              px,
              py,
              labelY: Number.isFinite(labelY) ? labelY : terrainLabelY(repository, py),
            },
          ]];
        }),
      );
      positionOverridesRef.current = validLayout;
      frameId = window.requestAnimationFrame(() => setPositionOverrides(validLayout));
    } catch {
      window.localStorage.removeItem(TERRAIN_LAYOUT_STORAGE_KEY);
    }
    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, [repositories]);

  useEffect(() => {
    interactionPanRef.current = pan;
    interactionZoomRef.current = zoom;
  }, [pan, zoom]);

  const positionedRepositories = useMemo(
    () => repositories.map((repository) => {
      const position = positionOverrides[repository.id];
      return position ? { ...repository, ...position } : repository;
    }),
    [positionOverrides, repositories],
  );
  const availableRepositories = useMemo(
    () => positionedRepositories.filter((repository) => repository.created <= year),
    [positionedRepositories, year],
  );
  const timelineRepositories = useMemo(
    () => availableRepositories
      .filter((repository) => repositoryHasLanguage(repository, language))
      .sort((a, b) => a.created - b.created || b.lines - a.lines),
    [availableRepositories, language],
  );
  const timelineGroups = useMemo(() => {
    const firstYear = Math.min(year, ...timelineRepositories.map((repository) => repository.created));
    return Array.from({ length: Math.max(1, year - firstYear + 1) }, (_, index) => {
      const groupYear = firstYear + index;
      return {
        year: groupYear,
        repositories: timelineRepositories.filter((repository) => repository.created === groupYear),
      };
    });
  }, [timelineRepositories, year]);
  const timelineTotals = useMemo(
    () => timelineRepositories.reduce(
      (totals, repository) => ({
        lines: totals.lines + repository.lines,
        commits: totals.commits + repository.commits,
      }),
      { lines: 0, commits: 0 },
    ),
    [timelineRepositories],
  );
  const timelineMaxLines = Math.max(1, ...timelineRepositories.map((repository) => repository.lines));
  const repositoryIndices = useMemo(
    () => new Map(repositories.map((repository, index) => [repository.id, index])),
    [repositories],
  );
  const availableLanguages = useMemo(() => getLanguageFilters(repositories), [repositories]);
  const currentYear = new Date().getFullYear();
  const firstRepositoryYear = Math.min(currentYear, ...repositories.map((repository) => repository.created));
  const hasCustomTerrainLayout = Object.keys(positionOverrides).length > 0;
  const timelineYears = useMemo(() => {
    const span = currentYear - firstRepositoryYear;
    const step = Math.max(1, Math.ceil(span / 7));
    const values = Array.from(
      { length: Math.floor(span / step) + 1 },
      (_, index) => firstRepositoryYear + index * step,
    );
    if (values.at(-1) !== currentYear) values.push(currentYear);
    return values;
  }, [currentYear, firstRepositoryYear]);
  const selectedTerrain = useMemo(() => {
    const repository = availableRepositories.find((item) => item.id === selectedId);
    if (!repository || !repositoryHasLanguage(repository, language)) return null;
    return {
      repository,
      geometry: terrainGeometry(repository, size, zoom, year, pan),
    };
  }, [availableRepositories, language, pan, selectedId, size, year, zoom]);
  const lastWalkMarker = useMemo(() => {
    if (!lastWalkPosition) return null;
    const scale = zoom / 100;
    return {
      x: size.width / 2 + (lastWalkPosition.px * size.width - size.width / 2) * scale + pan.x,
      y: size.height / 2 + (lastWalkPosition.py * size.height - size.height / 2) * scale + pan.y,
    };
  }, [lastWalkPosition, pan, size, zoom]);
  const detailsRepository = useMemo(
    () => repositories.find((repository) => repository.id === detailsRepositoryId) ?? null,
    [detailsRepositoryId, repositories],
  );
  const detailLanguageProfile = useMemo(() => {
    if (!detailsRepository) return [];
    const entries = Object.entries(detailsRepository.languageBreakdown ?? {})
      .sort(([, bytesA], [, bytesB]) => bytesB - bytesA)
      .slice(0, 4);
    const total = entries.reduce((sum, [, bytes]) => sum + bytes, 0);
    if (!entries.length || total === 0) {
      return [{ name: detailsRepository.language, percentage: 100 }];
    }
    return entries.map(([name, bytes]) => ({
      name,
      percentage: Math.max(1, Math.round((bytes / total) * 100)),
    }));
  }, [detailsRepository]);

  const clampPan = useCallback((point: Point) => {
    const limitX = Math.max(120, size.width * 0.42);
    const limitY = Math.max(100, size.height * 0.38);
    return {
      x: Math.max(-limitX, Math.min(limitX, point.x)),
      y: Math.max(-limitY, Math.min(limitY, point.y)),
    };
  }, [size]);

  const resetView = useCallback(() => {
    setPan({ x: 0, y: 0 });
    onZoomChange(100);
  }, [onZoomChange]);

  const enterImmersiveView = useCallback(() => {
    setArmedRepositoryId(null);
    setDetailsRepositoryId(null);
    onImmersiveChange(true);
    requestAnimationFrame(() => canvasRef.current?.focus());
  }, [onImmersiveChange]);

  useEffect(() => {
    if (!isImmersive) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.body.classList.add("terrain-immersive");
    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.classList.remove("terrain-immersive");
    };
  }, [isImmersive]);

  useEffect(() => {
    if (!isImmersive) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (detailsRepositoryId) setDetailsRepositoryId(null);
      else if (mapKeyOpen) onCloseMapKey();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [detailsRepositoryId, isImmersive, mapKeyOpen, onCloseMapKey]);

  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      if (width && height) setSize({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(size.width * dpr);
    const pixelHeight = Math.round(size.height * dpr);
    const sizeChanged = canvas.width !== pixelWidth || canvas.height !== pixelHeight;
    const panChanged = renderedPanRef.current.x !== pan.x || renderedPanRef.current.y !== pan.y;
    const skipTransition = skipTransitionRef.current;
    skipTransitionRef.current = false;
    renderedPanRef.current = pan;
    const source = sizeChanged || panChanged || skipTransition ? null : document.createElement("canvas");

    if (source) {
      source.width = pixelWidth;
      source.height = pixelHeight;
      source.getContext("2d")?.drawImage(canvas, 0, 0);
    }

    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;

    const target = document.createElement("canvas");
    target.width = pixelWidth;
    target.height = pixelHeight;
    const targetContext = target.getContext("2d");
    const context = canvas.getContext("2d");
    if (!targetContext || !context) return;
    targetContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawTerrainScene(targetContext, availableRepositories, selectedId, size, zoom, year, language, pan, dpr);

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!source || reducedMotion) {
      context.drawImage(target, 0, 0);
      return;
    }

    const startedAt = performance.now();
    const duration = 520;
    const renderFrame = (timestamp: number) => {
      const progress = Math.min(1, (timestamp - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      context.clearRect(0, 0, pixelWidth, pixelHeight);
      context.globalAlpha = 1 - eased;
      context.drawImage(source, 0, 0);
      context.globalAlpha = eased;
      context.drawImage(target, 0, 0);
      context.globalAlpha = 1;

      if (progress < 1) {
        animationFrameRef.current = requestAnimationFrame(renderFrame);
      } else {
        animationFrameRef.current = null;
      }
    };
    animationFrameRef.current = requestAnimationFrame(renderFrame);
  }, [availableRepositories, language, pan, selectedId, size, year, zoom]);

  useEffect(() => () => {
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    if (panFrameRef.current !== null) cancelAnimationFrame(panFrameRef.current);
    if (walkMountTimeoutRef.current !== null) window.clearTimeout(walkMountTimeoutRef.current);
    if (walkReadyTimeoutRef.current !== null) window.clearTimeout(walkReadyTimeoutRef.current);
  }, []);

  const renderTerrainFrame = useCallback((framePan: Point, frameZoom: number, transition = false) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = transition ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(size.width * dpr);
    const pixelHeight = Math.round(size.height * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const context = canvas.getContext("2d");
    if (!context) return;

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
    drawTerrainScene(context, availableRepositories, selectedId, size, frameZoom, year, language, framePan, dpr, { transition });
    renderedPanRef.current = framePan;
  }, [availableRepositories, language, selectedId, size, year]);

  const navigateToRepository = useCallback((repository: TerrainRepository) => {
    if (!isImmersive) return;
    const geometry = terrainGeometry(repository, size, zoom, year, pan);
    const target = clampPan({
      x: pan.x + size.width * 0.5 - geometry.centerX,
      y: pan.y + size.height * 0.54 - geometry.centerY,
    });
    const start = pan;
    if (Math.hypot(target.x - start.x, target.y - start.y) < 2) return;
    if (panFrameRef.current !== null) cancelAnimationFrame(panFrameRef.current);

    const startedAt = performance.now();
    const duration = 520;
    setIsNavigating(true);
    const navigateFrame = (timestamp: number) => {
      const progress = Math.min(1, (timestamp - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setPan({
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased,
      });
      if (progress < 1) {
        panFrameRef.current = requestAnimationFrame(navigateFrame);
      } else {
        panFrameRef.current = null;
        setIsNavigating(false);
      }
    };
    panFrameRef.current = requestAnimationFrame(navigateFrame);
  }, [clampPan, isImmersive, pan, size, year, zoom]);

  const handleRepositoryInteraction = useCallback((repository: TerrainRepository) => {
    if (!isImmersive) {
      onSelect(repository.id);
      return;
    }
    if (armedRepositoryId === repository.id && selectedId === repository.id) {
      onCloseMapKey();
      setDetailsRepositoryId(repository.id);
      return;
    }
    onCloseMapKey();
    setDetailsRepositoryId(null);
    setArmedRepositoryId(repository.id);
    onSelect(repository.id);
    if (atlasMode === "terra") navigateToRepository(repository);
  }, [armedRepositoryId, atlasMode, isImmersive, navigateToRepository, onCloseMapKey, onSelect, selectedId]);

  const handleMapKeyToggle = useCallback(() => {
    setDetailsRepositoryId(null);
    onToggleMapKey();
  }, [onToggleMapKey]);

  const handleWalkPositionChange = useCallback((position: WalkModePosition) => {
    setLastWalkPosition((current) => {
      if (current && Math.hypot(current.px - position.px, current.py - position.py) < 0.001) return current;
      return position;
    });
  }, []);

  const clearWalkReadyTimer = useCallback(() => {
    if (walkMountTimeoutRef.current !== null) {
      window.clearTimeout(walkMountTimeoutRef.current);
      walkMountTimeoutRef.current = null;
    }
    if (walkReadyTimeoutRef.current !== null) {
      window.clearTimeout(walkReadyTimeoutRef.current);
      walkReadyTimeoutRef.current = null;
    }
  }, []);

  const beginWalkModeHandoff = useCallback(() => {
    clearWalkReadyTimer();
    walkLoadingStartedAtRef.current = performance.now();
    setIsWalkModeSettling(false);
    setIsWalkTransitioning(true);
    setIsWalkModeLoading(true);
    setAtlasTransitionLabel("Entering Walk Mode...");
    walkMountTimeoutRef.current = window.setTimeout(() => {
      walkMountTimeoutRef.current = null;
      setAtlasMode("walk");
    }, WALK_MODE_MOUNT_DELAY_MS);
  }, [clearWalkReadyTimer]);

  const transitionIntoWalkMode = useCallback(() => {
    clearWalkReadyTimer();
    setIsWalkModeSettling(false);
    if (panFrameRef.current !== null) cancelAnimationFrame(panFrameRef.current);
    panFrameRef.current = null;
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    const selectedRepository = availableRepositories.find((repository) => repository.id === selectedId) ?? availableRepositories[0];
    const targetPoint = lastWalkPosition ?? (selectedRepository
      ? { px: selectedRepository.px, py: selectedRepository.py }
      : { px: 0.5, py: 0.5 });
    const targetZoom = WALK_ENTRY_ZOOM;
    const targetScale = targetZoom / 100;
    const targetPan = clampPan({
      x: size.width * 0.5 - (size.width / 2 + (targetPoint.px * size.width - size.width / 2) * targetScale),
      y: size.height * 0.58 - (size.height / 2 + (targetPoint.py * size.height - size.height / 2) * targetScale),
    });
    const startPan = interactionPanRef.current;
    const startZoom = interactionZoomRef.current;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    walkReturnViewRef.current = { pan: startPan, zoom: startZoom };

    setAtlasMode("terra");
    setIsArranging(false);
    setArmedRepositoryId(null);
    setDetailsRepositoryId(null);
    onCloseMapKey();

    if (reducedMotion) {
      setPan(targetPan);
      onZoomChange(targetZoom);
      beginWalkModeHandoff();
      return;
    }

    const startedAt = performance.now();
    const duration = 1360;
    setIsNavigating(true);
    setIsWalkTransitioning(true);
    setAtlasTransitionLabel("Zooming into terrain");
    renderTerrainFrame(startPan, startZoom, true);

    const transitionFrame = (timestamp: number) => {
      const progress = Math.min(1, (timestamp - startedAt) / duration);
      const eased = progress < 0.5
        ? 4 * progress * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 3) / 2;
      const nextZoom = startZoom + (targetZoom - startZoom) * eased;
      renderTerrainFrame({
        x: startPan.x + (targetPan.x - startPan.x) * eased,
        y: startPan.y + (targetPan.y - startPan.y) * eased,
      }, nextZoom, true);

      if (progress < 1) {
        panFrameRef.current = requestAnimationFrame(transitionFrame);
      } else {
        panFrameRef.current = null;
        skipTransitionRef.current = true;
        setPan(targetPan);
        onZoomChange(targetZoom);
        setIsNavigating(false);
        beginWalkModeHandoff();
      }
    };

    panFrameRef.current = requestAnimationFrame(transitionFrame);
  }, [availableRepositories, beginWalkModeHandoff, clampPan, clearWalkReadyTimer, lastWalkPosition, onCloseMapKey, onZoomChange, renderTerrainFrame, selectedId, size]);

  const transitionBackToTerraView = useCallback(() => {
    clearWalkReadyTimer();
    if (panFrameRef.current !== null) cancelAnimationFrame(panFrameRef.current);
    panFrameRef.current = null;
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    const startPan = interactionPanRef.current;
    const startZoom = interactionZoomRef.current;
    const targetView = walkReturnViewRef.current ?? { pan: { x: 0, y: 0 }, zoom: 100 };
    const targetPan = targetView.pan;
    const targetZoom = targetView.zoom;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    setAtlasMode("terra");
    setIsWalkModeLoading(false);
    setIsWalkModeSettling(false);
    setIsArranging(false);
    setArmedRepositoryId(null);
    setDetailsRepositoryId(null);
    onCloseMapKey();

    if (reducedMotion) {
      skipTransitionRef.current = true;
      setPan(targetPan);
      onZoomChange(targetZoom);
      return;
    }

    const startedAt = performance.now();
    const duration = 1120;
    setIsNavigating(true);
    setIsWalkTransitioning(true);
    setAtlasTransitionLabel("Returning to Terra View");
    renderTerrainFrame(startPan, startZoom, true);

    const transitionFrame = (timestamp: number) => {
      const progress = Math.min(1, (timestamp - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const nextZoom = startZoom + (targetZoom - startZoom) * eased;
      renderTerrainFrame({
        x: startPan.x + (targetPan.x - startPan.x) * eased,
        y: startPan.y + (targetPan.y - startPan.y) * eased,
      }, nextZoom, true);

      if (progress < 1) {
        panFrameRef.current = requestAnimationFrame(transitionFrame);
      } else {
        panFrameRef.current = null;
        skipTransitionRef.current = true;
        renderTerrainFrame(targetPan, targetZoom);
        setPan(targetPan);
        onZoomChange(targetZoom);
        setIsNavigating(false);
        setIsWalkTransitioning(false);
        setAtlasTransitionLabel(null);
      }
    };

    panFrameRef.current = requestAnimationFrame(transitionFrame);
  }, [clearWalkReadyTimer, onCloseMapKey, onZoomChange, renderTerrainFrame]);

  const switchAtlasMode = useCallback((mode: AtlasMode) => {
    clearWalkReadyTimer();
    if (panFrameRef.current !== null) {
      cancelAnimationFrame(panFrameRef.current);
      panFrameRef.current = null;
    }
    setIsNavigating(false);
    setIsWalkTransitioning(false);
    setIsWalkModeLoading(false);
    setIsWalkModeSettling(false);
    setAtlasTransitionLabel(null);
    setIsArranging(false);
    setArmedRepositoryId(null);
    setDetailsRepositoryId(null);
    onCloseMapKey();
    if (mode === "terra" && atlasMode === "walk") {
      transitionBackToTerraView();
      return;
    }
    if (mode === "walk" && atlasMode !== "walk") {
      transitionIntoWalkMode();
      return;
    }
    setAtlasMode(mode);
  }, [atlasMode, clearWalkReadyTimer, onCloseMapKey, transitionBackToTerraView, transitionIntoWalkMode]);

  const handleWalkModeReady = useCallback(() => {
    clearWalkReadyTimer();
    const elapsed = performance.now() - walkLoadingStartedAtRef.current;
    const remainingLoadingTime = Math.max(0, WALK_MODE_MIN_LOADING_MS - elapsed);

    const finishWalkModeHandoff = () => {
      walkReadyTimeoutRef.current = null;
      setIsWalkModeLoading(false);
      setIsWalkModeSettling(true);
      setAtlasTransitionLabel("Walk Mode Ready");
      walkReadyTimeoutRef.current = window.setTimeout(() => {
        walkReadyTimeoutRef.current = null;
        setIsWalkModeSettling(false);
        setIsWalkTransitioning(false);
        setAtlasTransitionLabel(null);
      }, 560);
    };

    if (remainingLoadingTime > 0) {
      walkReadyTimeoutRef.current = window.setTimeout(finishWalkModeHandoff, remainingLoadingTime);
    } else {
      finishWalkModeHandoff();
    }
  }, [clearWalkReadyTimer]);

  const terrainAtPoint = useCallback(
    (point: Point) => {
      const candidates = availableRepositories
        .filter((repository) => repositoryHasLanguage(repository, language))
        .map((repository) => {
          const geometry = terrainGeometry(repository, size, zoom, year, pan);
          const dx = (point.x - geometry.centerX) / (geometry.radiusX * 1.22);
          const dy = (point.y - geometry.centerY) / (geometry.radiusY * 1.7);
          return { repository, distance: Math.sqrt(dx * dx + dy * dy) };
        })
        .sort((a, b) => a.distance - b.distance);
      return candidates[0] && candidates[0].distance <= 1.35
        ? candidates[0].repository
        : null;
    },
    [availableRepositories, language, pan, size, year, zoom],
  );

  const selectTerrainAt = useCallback((point: Point) => {
    const repository = terrainAtPoint(point);
    if (repository) handleRepositoryInteraction(repository);
  }, [handleRepositoryInteraction, terrainAtPoint]);

  const persistTerrainLayout = useCallback(() => {
    window.localStorage.setItem(
      TERRAIN_LAYOUT_STORAGE_KEY,
      JSON.stringify(positionOverridesRef.current),
    );
  }, []);

  const resetTerrainLayout = useCallback(() => {
    if (hasCustomTerrainLayout) {
      positionOverridesRef.current = {};
      setPositionOverrides({});
      window.localStorage.removeItem(TERRAIN_LAYOUT_STORAGE_KEY);
      return;
    }

    const nextLayout = createTerrainArrangement(repositories, year);
    positionOverridesRef.current = nextLayout;
    setPositionOverrides(nextLayout);
    persistTerrainLayout();
  }, [hasCustomTerrainLayout, persistTerrainLayout, repositories, year]);

  const toggleArrangeMode = useCallback(() => {
    setDetailsRepositoryId(null);
    setArmedRepositoryId(null);
    onCloseMapKey();
    setIsArranging((current) => !current);
  }, [onCloseMapKey]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    if (panFrameRef.current !== null) cancelAnimationFrame(panFrameRef.current);
    panFrameRef.current = null;
    setIsNavigating(false);
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = event.currentTarget.getBoundingClientRect();
    const targetRepository = isArranging
      ? terrainAtPoint({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
      : null;
    if (targetRepository) {
      onSelect(targetRepository.id);
      setDetailsRepositoryId(null);
      setArmedRepositoryId(null);
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: pan,
      moved: false,
      mode: targetRepository ? "terrain" : "pan",
      repositoryId: targetRepository?.id,
      terrainOrigin: targetRepository
        ? { px: targetRepository.px, py: targetRepository.py, labelY: targetRepository.labelY }
        : undefined,
      terrainWasCustomized: targetRepository
        ? Boolean(positionOverridesRef.current[targetRepository.id])
        : undefined,
    };
    setIsDragging(true);
  }, [isArranging, onSelect, pan, terrainAtPoint]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (Math.hypot(deltaX, deltaY) > 4) drag.moved = true;
    if (panFrameRef.current !== null) cancelAnimationFrame(panFrameRef.current);
    if (drag.mode === "terrain" && drag.repositoryId && drag.terrainOrigin) {
      const scale = zoom / 100;
      const nextPosition = {
        px: Math.max(.05, Math.min(.95, drag.terrainOrigin.px + deltaX / Math.max(1, size.width * scale))),
        py: Math.max(.1, Math.min(.9, drag.terrainOrigin.py + deltaY / Math.max(1, size.height * scale))),
        labelY: Math.max(.05, Math.min(.95, drag.terrainOrigin.labelY + deltaY / Math.max(1, size.height * scale))),
      };
      const nextLayout = {
        ...positionOverridesRef.current,
        [drag.repositoryId]: nextPosition,
      };
      positionOverridesRef.current = nextLayout;
      panFrameRef.current = requestAnimationFrame(() => {
        setPositionOverrides(nextLayout);
        panFrameRef.current = null;
      });
      return;
    }
    const nextPan = clampPan({ x: drag.origin.x + deltaX, y: drag.origin.y + deltaY });
    panFrameRef.current = requestAnimationFrame(() => {
      setPan(nextPan);
      panFrameRef.current = null;
    });
  }, [clampPan, size, zoom]);

  const finishPointerInteraction = useCallback((event: React.PointerEvent<HTMLCanvasElement>, cancelled = false) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (panFrameRef.current !== null) {
      cancelAnimationFrame(panFrameRef.current);
      panFrameRef.current = null;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.mode === "terrain" && drag.repositoryId && drag.terrainOrigin) {
      if (cancelled) {
        const restoredLayout = { ...positionOverridesRef.current };
        if (drag.terrainWasCustomized) restoredLayout[drag.repositoryId] = drag.terrainOrigin;
        else delete restoredLayout[drag.repositoryId];
        positionOverridesRef.current = restoredLayout;
        setPositionOverrides(restoredLayout);
      } else if (drag.moved) {
        setPositionOverrides(positionOverridesRef.current);
        persistTerrainLayout();
      }
    } else if (drag.mode === "pan" && !drag.moved && !cancelled) {
      const bounds = event.currentTarget.getBoundingClientRect();
      selectTerrainAt({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
    }
    dragRef.current = null;
    setIsDragging(false);
  }, [persistTerrainLayout, selectTerrainAt]);

  const handleWheelZoom = useCallback((event: WheelEvent) => {
    if (!isImmersive || atlasMode !== "terra") return;
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas || event.deltaY === 0) return;

    const normalizedDelta = event.deltaMode === 1
      ? event.deltaY * 16
      : event.deltaMode === 2
        ? event.deltaY * size.height
        : event.deltaY;
    const currentZoom = interactionZoomRef.current;
    const currentPan = interactionPanRef.current;
    const zoomDelta = Math.max(-4, Math.min(4, -normalizedDelta * 0.035));
    const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, currentZoom + zoomDelta));
    if (Math.abs(nextZoom - currentZoom) < 0.01) return;

    const bounds = canvas.getBoundingClientRect();
    const focus = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    const currentScale = currentZoom / 100;
    const nextScale = nextZoom / 100;
    const worldX = (focus.x - size.width / 2 - currentPan.x) / currentScale;
    const worldY = (focus.y - size.height / 2 - currentPan.y) / currentScale;
    const nextPan = clampPan({
      x: focus.x - size.width / 2 - worldX * nextScale,
      y: focus.y - size.height / 2 - worldY * nextScale,
    });

    skipTransitionRef.current = true;
    interactionPanRef.current = nextPan;
    interactionZoomRef.current = nextZoom;
    setPan(nextPan);
    onZoomChange(Number(nextZoom.toFixed(2)));
  }, [atlasMode, clampPan, isImmersive, onZoomChange, size]);

  useEffect(() => {
    if (!isImmersive || atlasMode !== "terra") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener("wheel", handleWheelZoom, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheelZoom);
  }, [atlasMode, handleWheelZoom, isImmersive]);

  const handleMapKeyDown = useCallback((event: React.KeyboardEvent<HTMLCanvasElement>) => {
    const movement = event.shiftKey ? 48 : 24;
    if (event.key === "ArrowLeft") setPan((current) => clampPan({ x: current.x + movement, y: current.y }));
    else if (event.key === "ArrowRight") setPan((current) => clampPan({ x: current.x - movement, y: current.y }));
    else if (event.key === "ArrowUp") setPan((current) => clampPan({ x: current.x, y: current.y + movement }));
    else if (event.key === "ArrowDown") setPan((current) => clampPan({ x: current.x, y: current.y - movement }));
    else if (isImmersive && atlasMode === "terra" && (event.key === "+" || event.key === "=")) onZoomChange(Math.min(MAX_ZOOM, zoom + 5));
    else if (isImmersive && atlasMode === "terra" && event.key === "-") onZoomChange(Math.max(MIN_ZOOM, zoom - 5));
    else if (event.key === "Home") resetView();
    else return;
    event.preventDefault();
  }, [atlasMode, clampPan, isImmersive, onZoomChange, resetView, zoom]);

  return (
    <div className={`terrain-stage${isDragging ? " is-dragging" : ""}${isNavigating ? " is-navigating" : ""}${isArranging ? " is-arranging" : ""}${isWalkTransitioning ? " is-walk-transitioning" : ""}${isImmersive ? " is-immersive" : ""}${isImmersive && atlasMode === "timeline" ? " is-timeline" : ""}${isImmersive && atlasMode === "walk" ? " is-walk" : ""}`} ref={wrapperRef}>
      <canvas
        ref={canvasRef}
        className="terrain-canvas"
        aria-label={isArranging
          ? "Arrange terrain map. Drag a terrain to move it, or drag empty space to pan."
          : `Interactive repository map. Drag or use arrow keys to move the map${isImmersive ? ", and use the visible controls to zoom" : ""}.`}
        aria-hidden={isImmersive && atlasMode !== "terra"}
        tabIndex={isImmersive && atlasMode !== "terra" ? -1 : 0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finishPointerInteraction(event)}
        onPointerCancel={(event) => finishPointerInteraction(event, true)}
        onKeyDown={handleMapKeyDown}
      />

      {(!isImmersive || atlasMode === "terra") && (
        <div className="coordinate-strip" aria-hidden="true">
          <span>ATLAS / LIVE</span>
          <span>{year}</span>
          <span>E {Math.round(pan.x)} / N {Math.round(-pan.y)}</span>
          <span>{isArranging
            ? "DRAG TERRAIN TO MOVE · DRAG EMPTY SPACE TO PAN"
            : isImmersive
              ? "SCROLL TO ZOOM · SELECT TWICE FOR DETAILS"
              : "OPEN FULL TERRAIN FOR ZOOM"}</span>
        </div>
      )}

      {!isImmersive && (
        <button type="button" className="fullscreen-control" onClick={enterImmersiveView} aria-label="Open full screen terrain view">
          <i aria-hidden="true"/>
          <span>Full terrain</span>
        </button>
      )}

      {isImmersive && (
        <div className="immersive-map-bar">
          <div>
            <span>CODE TERRA / LIVE ATLAS</span>
            <strong>{timelineRepositories.length} REPOSITORIES IN VIEW</strong>
          </div>
          <nav aria-label="Atlas navigation and controls">
            <button type="button" className={`atlas-mode-toggle is-terra${atlasMode === "terra" || atlasTransitionLabel === "Returning to Terra View" ? " active" : ""}`} onClick={() => switchAtlasMode("terra")} aria-pressed={atlasMode === "terra" || atlasTransitionLabel === "Returning to Terra View"}>
              <i aria-hidden="true"/>
              Terra View
            </button>
            <button type="button" className={`atlas-mode-toggle is-timeline${atlasMode === "timeline" ? " active" : ""}`} onClick={() => switchAtlasMode("timeline")} aria-pressed={atlasMode === "timeline"}>
              <i aria-hidden="true"/>
              Timeline View
            </button>
            <button type="button" className={`atlas-mode-toggle is-walk${atlasMode === "walk" || atlasTransitionLabel === "Zooming into terrain" ? " active" : ""}`} onClick={() => switchAtlasMode("walk")} aria-pressed={atlasMode === "walk" || atlasTransitionLabel === "Zooming into terrain"}>
              <i aria-hidden="true"/>
              {atlasTransitionLabel === "Zooming into terrain" ? "Entering Walk" : "Walk Mode"}
            </button>
            {atlasMode === "terra" && (
              <button
                type="button"
                className={`arrange-terrain-control${isArranging ? " active" : ""}`}
                onClick={toggleArrangeMode}
                aria-pressed={isArranging}
              >
                {isArranging ? "Done arranging" : "Arrange terrain"}
              </button>
            )}
            {atlasMode === "terra" && (
              <button
                type="button"
                className="reset-terrain-control"
                onClick={resetTerrainLayout}
              >
                Reset terrain
              </button>
            )}
            {atlasMode === "terra" && <button type="button" onClick={handleMapKeyToggle}>{mapKeyOpen ? "Hide map key" : "Map key"}</button>}
            {onLogout && (
              <button type="button" className="logout-control" onClick={onLogout} disabled={isLoggingOut}>
                {isLoggingOut ? "Logging out" : "Logout"}
              </button>
            )}
          </nav>
        </div>
      )}

      {isImmersive && atlasMode === "timeline" && (
        <section className="timeline-atlas-view" aria-labelledby="timeline-atlas-title">
          <header className="timeline-atlas-heading">
            <div>
              <p>TIMELINE / REPOSITORY HISTORY</p>
              <h2 id="timeline-atlas-title">Your landscape,<br/><em>through time.</em></h2>
            </div>
            <dl>
              <div><dt>Terrains</dt><dd>{timelineRepositories.length}</dd></div>
              <div><dt>Est. LOC</dt><dd>{compactNumber(timelineTotals.lines)}</dd></div>
              <div><dt>Commits</dt><dd>{compactNumber(timelineTotals.commits)}</dd></div>
              <div><dt>Through</dt><dd>{year}</dd></div>
            </dl>
          </header>

          <div className="timeline-atlas-scroll">
            <div className="timeline-atlas-grid" style={{ "--timeline-years": timelineGroups.length } as React.CSSProperties}>
              {timelineGroups.map((group) => (
                <article className="timeline-year-column" key={group.year}>
                  <header>
                    <span>{group.year}</span>
                    <small>{group.repositories.length} {group.repositories.length === 1 ? "terrain" : "terrains"}</small>
                  </header>
                  <div className="timeline-year-marker"><i/></div>
                  <div className="timeline-year-repositories">
                    {group.repositories.length === 0 && <p>NO NEW TERRAIN</p>}
                    {group.repositories.map((repository) => {
                      const repositoryIndex = repositoryIndices.get(repository.id) ?? 0;
                      const selected = repository.id === selectedId;
                      return (
                        <button
                          type="button"
                          key={repository.id}
                          className={`timeline-repository-card${selected ? " is-selected" : ""}`}
                          onClick={() => handleRepositoryInteraction(repository)}
                          style={{ "--repo-color": repository.color } as React.CSSProperties}
                          aria-label={armedRepositoryId === repository.id && selected
                            ? `Show details for ${repository.name}`
                            : `Select ${repository.name}`}
                        >
                          <span className="timeline-card-index"><i/>{labelNumber(repositoryIndex)}</span>
                          <strong>{repository.name}</strong>
                          <small>{repository.language} · {compactNumber(repository.lines)} LOC</small>
                          <span className="timeline-card-signal" aria-hidden="true">
                            <i style={{ width: `${Math.max(8, (repository.lines / timelineMaxLines) * 100)}%` }}/>
                          </span>
                          <span className="timeline-card-meta">
                            <span>
                              <small>Commits</small>
                              <strong>{repository.commitCountAvailable ? compactNumber(repository.commits) : "Unavailable"}</strong>
                            </span>
                            <span>
                              <small>Last activity</small>
                              <strong>{repository.activity}</strong>
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>
      )}

      {isWalkTransitioning && (
        <div className="walk-transition-vignette" aria-hidden="true">
          <span>{atlasTransitionLabel ?? "Crossing terrain"}</span>
        </div>
      )}

      {(isWalkModeLoading || isWalkModeSettling) && (
        <div className={`walk-mode-loading walk-handoff-loading${isWalkModeSettling ? " is-exiting" : ""}`} role="status" aria-live="polite">
          <span className="walk-mode-loading-scan" aria-hidden="true"/>
          <span className="walk-mode-loading-orbit" aria-hidden="true"/>
          <p>Entering Walk Mode...</p>
          <strong>Preparing terrain</strong>
          <small>Loading first-person atlas</small>
          <span className="walk-mode-loading-progress" aria-hidden="true"/>
        </div>
      )}

      {isImmersive && atlasMode === "walk" && (
        <WalkModeScene
          repositories={availableRepositories}
          selectedId={selectedId}
          year={year}
          language={language}
          onSelect={onSelect}
          onPositionChange={handleWalkPositionChange}
          onReady={handleWalkModeReady}
          initialPosition={lastWalkPosition}
        />
      )}

      {atlasMode === "terra" && lastWalkMarker && (
        <div
          className="walk-position-ping"
          aria-label="Last Walk Mode position"
          style={{
            left: `${lastWalkMarker.x}px`,
            top: `${lastWalkMarker.y}px`,
          }}
        >
          <span className="walk-position-ping-ring"/>
          <span className="walk-position-ping-ring is-delayed"/>
          <span className="walk-position-ping-core"/>
          <small>Last walk</small>
        </div>
      )}

      {atlasMode === "terra" && selectedTerrain && (
        <div
          className="survey-flight"
          aria-hidden="true"
          style={{
            left: `${selectedTerrain.geometry.centerX}px`,
            top: `${selectedTerrain.geometry.centerY - selectedTerrain.geometry.height - 22}px`,
            "--survey-color": selectedTerrain.repository.color,
          } as React.CSSProperties}
        >
          <span className="survey-orbit"/>
          <span className="survey-craft">
            <i className="survey-trail"/>
            <i className="survey-wing survey-wing-left"/>
            <i className="survey-body"/>
            <i className="survey-wing survey-wing-right"/>
            <b>CT-01</b>
          </span>
        </div>
      )}

      {atlasMode === "terra" && (
      <div className="terrain-labels" aria-label="Repository map labels">
        {availableRepositories.map((repository) => {
          const repositoryIndex = repositoryIndices.get(repository.id) ?? 0;
          const scale = zoom / 100;
          const x = size.width / 2 + (repository.px * size.width - size.width / 2) * scale + pan.x;
          const y = size.height / 2 + (repository.labelY * size.height - size.height / 2) * scale + pan.y;
          const selected = repository.id === selectedId;
          const dimmed = !repositoryHasLanguage(repository, language);
          return (
            <button
              type="button"
              key={repository.id}
              className={`terrain-label${selected ? " is-selected" : ""}${dimmed ? " is-dimmed" : ""}`}
              style={{ left: `${x}px`, top: `${y}px`, "--repo-color": repository.color } as React.CSSProperties}
              onClick={() => isArranging ? onSelect(repository.id) : handleRepositoryInteraction(repository)}
              disabled={dimmed}
              aria-label={isImmersive && armedRepositoryId === repository.id && selected
                ? `Show details for ${repository.name}`
                : `Select ${repository.name}`}
            >
              <span className="terrain-label-index">{labelNumber(repositoryIndex)}</span>
              {selected && (
                <span className="terrain-label-detail">
                  <strong>{repository.name}</strong>
                  <small>{compactNumber(repository.lines)} LOC</small>
                </span>
              )}
            </button>
          );
        })}
      </div>
      )}

      {isImmersive && atlasMode === "terra" && (
        <>
          <div className="zoom-control" aria-label="Map zoom controls">
            <button type="button" onClick={() => onZoomChange(Math.min(MAX_ZOOM, zoom + 5))} aria-label="Zoom in">+</button>
            <span>{Math.round(zoom)}%</span>
            <button type="button" onClick={() => onZoomChange(Math.max(MIN_ZOOM, zoom - 5))} aria-label="Zoom out">−</button>
          </div>

          <button type="button" className="map-compass" onClick={resetView} aria-label="Reset map position and zoom">
            <span>N</span>
            <i/>
          </button>
        </>
      )}

      {atlasMode === "terra" && (
        <div className="map-scale" aria-hidden="true">
          <span/>
          <small>REPOSITORY SPACE</small>
        </div>
      )}

      {isImmersive && atlasMode === "terra" && (
        <section className="terrain-language-dock" aria-label="Filter terrain by repository language">
          <header>
            <span>Languages used</span>
            {isArranging && hasCustomTerrainLayout
              ? <button type="button" onClick={resetTerrainLayout}>Reset layout</button>
              : <small>{Math.max(0, availableLanguages.length - 1)} detected</small>}
          </header>
          <div className="terrain-language-list">
            {availableLanguages.map((item) => (
              <button
                type="button"
                key={item}
                className={language === item ? "active" : ""}
                onClick={() => onLanguageChange(item)}
                aria-pressed={language === item}
              >
                <i
                  aria-hidden="true"
                  style={{ background: item === "All" ? "#d8f56a" : languageColor(item, repositories) }}
                />
                <span>{item}</span>
                <small>{languageCount(item, repositories)}</small>
              </button>
            ))}
          </div>
        </section>
      )}

      {atlasMode === "terra" && mapKeyOpen && (
        <div className="map-key" role="dialog" aria-label="Terrain map key">
          <div className="map-key-heading">
            <div>
              <span className="eyebrow light">MAP KEY / 01</span>
              <h3>Reading the terrain</h3>
            </div>
            <button type="button" onClick={onCloseMapKey} aria-label="Close map key">×</button>
          </div>
          <dl>
            <div><dt>Height</dt><dd>Lines of code</dd></div>
            <div><dt>Footprint</dt><dd>File count</dd></div>
            <div><dt>Contours</dt><dd>Commits</dd></div>
            <div><dt>Glow</dt><dd>Recent activity</dd></div>
            <div><dt>Routes</dt><dd>Repository history</dd></div>
            <div><dt>CT-01</dt><dd>Selected terrain</dd></div>
          </dl>
          <p>Filter the landscape</p>
          <div className="map-key-languages">
            {availableLanguages.map((item) => (
              <button
                type="button"
                key={item}
                className={language === item ? "active" : ""}
                onClick={() => onLanguageChange(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
      )}

      {isImmersive && detailsRepository && (
        <aside
          className="terrain-details-panel"
          role="dialog"
          aria-label={`${detailsRepository.name} repository details`}
          style={{ "--detail-color": detailsRepository.color } as React.CSSProperties}
        >
          <header>
            <span>TERRAIN DOSSIER / {labelNumber(repositories.findIndex((repository) => repository.id === detailsRepository.id))}</span>
            <button type="button" onClick={() => setDetailsRepositoryId(null)} aria-label="Close repository details">×</button>
          </header>
          <div className="terrain-details-flags">
            <span><i style={{ background: detailsRepository.color }}/>{detailsRepository.language}</span>
            <span>{detailsRepository.private ? "PRIVATE" : "PUBLIC"}</span>
          </div>
          <div className="terrain-details-title">
            <p>REPOSITORY TERRAIN</p>
            <h2>{detailsRepository.name}</h2>
            <span>Created {detailsRepository.created} · Active {detailsRepository.activity}</span>
          </div>
          <dl className="terrain-details-metrics">
            <div>
              <dt>{detailsRepository.metricsEstimated ? "EST. LOC" : "LINES"}</dt>
              <dd>{detailsRepository.metricsEstimated ? "~" : ""}{compactNumber(detailsRepository.lines)}</dd>
            </div>
            <div>
              <dt>COMMITS</dt>
              <dd>{detailsRepository.commitCountAvailable ? detailsRepository.commits.toLocaleString("en") : "—"}</dd>
            </div>
            <div>
              <dt>FILES</dt>
              <dd>{detailsRepository.fileCountAvailable ? detailsRepository.files.toLocaleString("en") : "—"}</dd>
            </div>
          </dl>
          <div className="terrain-details-languages">
            <div><span>LANGUAGE PROFILE</span><strong>{detailLanguageProfile.length} DETECTED</strong></div>
            <div className="terrain-details-language-bar" aria-label="Repository language profile">
              {detailLanguageProfile.map((item) => (
                <i
                  key={item.name}
                  title={`${item.name}: ${item.percentage}%`}
                  style={{
                    width: `${item.percentage}%`,
                    background: languageColor(item.name, repositories),
                  }}
                />
              ))}
            </div>
            <div className="terrain-details-language-key">
              {detailLanguageProfile.map((item) => (
                <span key={item.name}><i style={{ background: languageColor(item.name, repositories) }}/>{item.name} {item.percentage}%</span>
              ))}
            </div>
          </div>
          <div className="terrain-details-footer">
            <span>READ-ONLY GITHUB DATA</span>
            {detailsRepository.repositoryUrl && (
              <a href={detailsRepository.repositoryUrl} target="_blank" rel="noreferrer">Open repository <b>→</b></a>
            )}
          </div>
        </aside>
      )}

      {!isImmersive && (
        <div className="timeline-control" id="timeline">
          <div className="timeline-copy">
            <span>HISTORY</span>
            <strong>THROUGH {year}</strong>
          </div>
          <input
            type="range"
            min={firstRepositoryYear}
            max={currentYear}
            step={1}
            value={year}
            onChange={(event) => onYearChange(Number(event.target.value))}
            aria-label="Repository timeline year"
          />
          <div className="timeline-years" aria-hidden="true">
            {timelineYears.map((item) => <span key={item}>{String(item).slice(2)}</span>)}
          </div>
        </div>
      )}
    </div>
  );
}
