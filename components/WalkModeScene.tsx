"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { compactNumber, repositoryHasLanguage, type LanguageFilter, type TerrainRepository } from "@/lib/repositories";
import { createRepositoryTerrainGeometry, repositoryTerrainHeightAt } from "@/components/walk-mode-terrain";

type WalkModeSceneProps = {
  repositories: TerrainRepository[];
  selectedId: string;
  year: number;
  language: LanguageFilter;
  onSelect: (id: string) => void;
  onPositionChange?: (position: WalkModePosition) => void;
  onReady?: () => void;
  initialPosition?: WalkModePosition | null;
};

type WalkKey = "forward" | "backward" | "left" | "right" | "run";
export type WalkModePosition = { px: number; py: number };

const POSITION_WORLD_SIZE = 7600;
const TERRAIN_WORLD_SIZE = 1240;
const EYE_HEIGHT = 20;
const MAX_PITCH = Math.PI * 0.42;
const GROUND_SIZE = POSITION_WORLD_SIZE * 1.56;
const POSITION_REPORT_INTERVAL = 120;
const GRASS_BLADE_COUNT = 2_000_000;
const GRASS_FIELD_SIZE = GROUND_SIZE * 0.9;

type GrassFieldMesh = THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
let grassFieldCache: { key: string; mesh: GrassFieldMesh } | null = null;

type WalkTerrainGeometry = {
  x: number;
  z: number;
  radiusX: number;
  radiusZ: number;
  height: number;
  growth: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function terraGrowth(repository: TerrainRepository, year: number) {
  return Math.min(1, 0.48 + (year - repository.created) * 0.13);
}

function terraWalkGeometry(repository: TerrainRepository, year: number) {
  const growth = terraGrowth(repository, year);
  const radiusX = TERRAIN_WORLD_SIZE * (0.22 + repository.spread * 0.16) * (0.72 + growth * 0.38);
  const radiusZ = radiusX * (0.86 + repository.relief * 0.22);
  const height = TERRAIN_WORLD_SIZE * (0.08 + 0.2 * repository.relief * growth);

  return {
    x: (repository.px - 0.5) * POSITION_WORLD_SIZE,
    z: (repository.py - 0.5) * POSITION_WORLD_SIZE,
    radiusX,
    radiusZ,
    height,
    growth,
  };
}

function walkWorldToAtlasPosition(x: number, z: number): WalkModePosition {
  return {
    px: clamp(x / POSITION_WORLD_SIZE + 0.5, 0, 1),
    py: clamp(z / POSITION_WORLD_SIZE + 0.5, 0, 1),
  };
}

function atlasPositionToWalkWorld(position: WalkModePosition) {
  return {
    x: (position.px - 0.5) * POSITION_WORLD_SIZE,
    z: (position.py - 0.5) * POSITION_WORLD_SIZE,
  };
}

function groundHeightAt(x: number, z: number) {
  const groundY = -z;
  return Math.sin(x * 0.035) * 0.42
    + Math.cos(groundY * 0.028) * 0.36
    + Math.sin((x + groundY) * 0.018) * 0.2;
}

function walkSurfaceHeightAt(
  x: number,
  z: number,
  mountainEntries: Array<WalkTerrainGeometry & { repository: TerrainRepository }>,
) {
  let surfaceHeight = groundHeightAt(x, z);

  mountainEntries.forEach((entry) => {
    const terrainHeight = repositoryTerrainHeightAt(
      entry.repository,
      entry,
      x - entry.x,
      z - entry.z,
    );
    surfaceHeight = Math.max(surfaceHeight, terrainHeight);
  });

  return surfaceHeight;
}

function nextGrassRandom(state: { value: number }) {
  state.value = (Math.imul(1664525, state.value) + 1013904223) >>> 0;
  return state.value / 0xffffffff;
}

function createGroundGeometry() {
  const geometry = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE, 90, 90);
  const positions = geometry.attributes.position;

  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const ripple = Math.sin(x * 0.035) * 0.42 + Math.cos(y * 0.028) * 0.36 + Math.sin((x + y) * 0.018) * 0.2;
    positions.setZ(index, ripple);
  }

  geometry.computeVertexNormals();
  return geometry;
}

function createMountainMeshGeometry(repository: TerrainRepository, geometry: WalkTerrainGeometry) {
  return createRepositoryTerrainGeometry(repository, geometry);
}

function createGrassClearingCells(mountainEntries: Array<WalkTerrainGeometry & { repository: TerrainRepository }>) {
  const cellSize = TERRAIN_WORLD_SIZE * 0.52;
  const cells = new Map<string, Array<WalkTerrainGeometry & { repository: TerrainRepository }>>();
  mountainEntries.forEach((entry) => {
    const radiusX = entry.radiusX * 1.1;
    const radiusZ = entry.radiusZ * 1.12;
    const minCellX = Math.floor((entry.x - radiusX) / cellSize);
    const maxCellX = Math.floor((entry.x + radiusX) / cellSize);
    const minCellZ = Math.floor((entry.z - radiusZ) / cellSize);
    const maxCellZ = Math.floor((entry.z + radiusZ) / cellSize);

    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
        const key = `${cellX}:${cellZ}`;
        const cell = cells.get(key);
        if (cell) cell.push(entry);
        else cells.set(key, [entry]);
      }
    }
  });

  return { cells, cellSize };
}

function moveOutOfMountainClearings(
  x: number,
  z: number,
  clearingCells: ReturnType<typeof createGrassClearingCells>,
  random: number,
) {
  const cellX = Math.floor(x / clearingCells.cellSize);
  const cellZ = Math.floor(z / clearingCells.cellSize);
  let nextX = x;
  let nextZ = z;

  for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
    for (let offsetZ = -1; offsetZ <= 1; offsetZ += 1) {
      const cell = clearingCells.cells.get(`${cellX + offsetX}:${cellZ + offsetZ}`);
      if (!cell) continue;
      cell.forEach((entry) => {
        const radiusX = entry.radiusX * 1.1;
        const radiusZ = entry.radiusZ * 1.12;
        const dx = (nextX - entry.x) / Math.max(1, radiusX);
        const dz = (nextZ - entry.z) / Math.max(1, radiusZ);
        if (dx * dx + dz * dz >= 1) return;
        const angle = Math.atan2(dz || random - 0.5, dx || random - 0.5);
        const margin = 1.02 + random * 0.18;
        nextX = entry.x + Math.cos(angle) * radiusX * margin;
        nextZ = entry.z + Math.sin(angle) * radiusZ * margin;
      });
    }
  }

  const fieldLimit = GRASS_FIELD_SIZE * 0.5;
  return {
    x: clamp(nextX, -fieldLimit, fieldLimit),
    z: clamp(nextZ, -fieldLimit, fieldLimit),
  };
}

function grassFieldCacheKey(mountainEntries: Array<WalkTerrainGeometry & { repository: TerrainRepository }>) {
  const terrainSignature = [...mountainEntries]
    .sort((a, b) => a.repository.id.localeCompare(b.repository.id))
    .map((entry) => [
      entry.repository.id,
      entry.x.toFixed(1),
      entry.z.toFixed(1),
      entry.radiusX.toFixed(1),
      entry.radiusZ.toFixed(1),
    ].join(":"))
    .join("|");

  return `${GRASS_BLADE_COUNT}:${GRASS_FIELD_SIZE.toFixed(1)}:${terrainSignature}`;
}

function createGrassField(mountainEntries: Array<WalkTerrainGeometry & { repository: TerrainRepository }>) {
  const cacheKey = grassFieldCacheKey(mountainEntries);
  if (grassFieldCache?.key === cacheKey) {
    grassFieldCache.mesh.parent?.remove(grassFieldCache.mesh);
    return grassFieldCache.mesh;
  }

  if (grassFieldCache) {
    grassFieldCache.mesh.parent?.remove(grassFieldCache.mesh);
    grassFieldCache.mesh.geometry.dispose();
    grassFieldCache.mesh.material.dispose();
    grassFieldCache = null;
  }

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -0.5, 0, 0,
    0.5, 0, 0,
    0, 1, 0.16,
  ], 3));

  const offsets = new Float32Array(GRASS_BLADE_COUNT * 3);
  const scales = new Float32Array(GRASS_BLADE_COUNT * 2);
  const rotations = new Float32Array(GRASS_BLADE_COUNT);
  const shades = new Float32Array(GRASS_BLADE_COUNT);
  const randomState = { value: 0x6d2b79f5 };
  const clearingCells = createGrassClearingCells(mountainEntries);

  for (let index = 0; index < GRASS_BLADE_COUNT; index += 1) {
    const rawX = (nextGrassRandom(randomState) - 0.5) * GRASS_FIELD_SIZE;
    const rawZ = (nextGrassRandom(randomState) - 0.5) * GRASS_FIELD_SIZE;
    const clearingRandom = nextGrassRandom(randomState);
    const { x, z } = moveOutOfMountainClearings(rawX, rawZ, clearingCells, clearingRandom);
    const height = 2.2 + nextGrassRandom(randomState) * 8.2;
    const width = 0.55 + nextGrassRandom(randomState) * 1.6;

    offsets[index * 3] = x;
    offsets[index * 3 + 1] = groundHeightAt(x, z) + 0.08;
    offsets[index * 3 + 2] = z;
    scales[index * 2] = width;
    scales[index * 2 + 1] = height;
    rotations[index] = nextGrassRandom(randomState) * Math.PI * 2;
    shades[index] = nextGrassRandom(randomState);
  }

  geometry.setAttribute("instanceOffset", new THREE.InstancedBufferAttribute(offsets, 3));
  geometry.setAttribute("instanceScale", new THREE.InstancedBufferAttribute(scales, 2));
  geometry.setAttribute("instanceRotation", new THREE.InstancedBufferAttribute(rotations, 1));
  geometry.setAttribute("instanceShade", new THREE.InstancedBufferAttribute(shades, 1));
  geometry.instanceCount = GRASS_BLADE_COUNT;

  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uRootColor: { value: new THREE.Color("#1a3317") },
        uTipColor: { value: new THREE.Color("#a6bf62") },
      },
    ]),
    vertexShader: `
      attribute vec3 instanceOffset;
      attribute vec2 instanceScale;
      attribute float instanceRotation;
      attribute float instanceShade;
      varying float vBladeHeight;
      varying float vShade;
      uniform float uTime;
      #include <fog_pars_vertex>

      void main() {
        vec3 transformed = position;
        float progress = transformed.y;
        transformed.x *= instanceScale.x;
        transformed.y *= instanceScale.y;
        transformed.z *= instanceScale.x;

        float wind = sin(uTime * 0.9 + instanceOffset.x * 0.017 + instanceOffset.z * 0.013 + instanceShade * 6.28318);
        transformed.x += wind * progress * progress * instanceScale.x * 0.42;
        transformed.z += cos(uTime * 0.72 + instanceOffset.z * 0.015) * progress * progress * instanceScale.x * 0.18;

        float s = sin(instanceRotation);
        float c = cos(instanceRotation);
        vec3 rotated = vec3(
          transformed.x * c - transformed.z * s,
          transformed.y,
          transformed.x * s + transformed.z * c
        );

        vBladeHeight = progress;
        vShade = instanceShade;
        vec4 mvPosition = modelViewMatrix * vec4(rotated + instanceOffset, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: `
      uniform vec3 uRootColor;
      uniform vec3 uTipColor;
      varying float vBladeHeight;
      varying float vShade;
      #include <fog_pars_fragment>

      void main() {
        vec3 grassColor = mix(uRootColor, uTipColor, smoothstep(0.08, 1.0, vBladeHeight));
        grassColor *= 0.72 + vShade * 0.42;
        gl_FragColor = vec4(grassColor, 1.0);
        #include <fog_fragment>
      }
    `,
    side: THREE.DoubleSide,
    fog: true,
  });

  const grass = new THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>(geometry, material);
  grass.userData.preserveAcrossWalkMode = true;
  grass.frustumCulled = false;
  grassFieldCache = { key: cacheKey, mesh: grass };
  return grass;
}

function movementKey(key: string): WalkKey | null {
  if (key === "w" || key === "arrowup") return "forward";
  if (key === "s" || key === "arrowdown") return "backward";
  if (key === "a" || key === "arrowleft") return "left";
  if (key === "d" || key === "arrowright") return "right";
  if (key === "shift") return "run";
  return null;
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    if (child.userData.preserveAcrossWalkMode) return;
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((item) => item.dispose());
    else material?.dispose();
  });
}

export default function WalkModeScene({ repositories, selectedId, year, language, onSelect, onPositionChange, onReady, initialPosition }: WalkModeSceneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  const onPositionChangeRef = useRef(onPositionChange);
  const onReadyRef = useRef(onReady);
  const selectedIdRef = useRef(selectedId);
  const initialPositionRef = useRef(initialPosition);
  const [pointerLocked, setPointerLocked] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);
  const [nearestRepository, setNearestRepository] = useState<TerrainRepository | null>(null);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    onPositionChangeRef.current = onPositionChange;
  }, [onPositionChange]);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setSceneReady(false);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#07110d");
    scene.fog = new THREE.FogExp2("#07110d", 0.00046);

    const camera = new THREE.PerspectiveCamera(64, 1, 0.1, 9800);
    camera.position.set(0, EYE_HEIGHT, 560);
    camera.rotation.order = "YXZ";

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setClearColor("#07110d");
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.className = "walk-mode-canvas";
    host.appendChild(renderer.domElement);

    const hemisphereLight = new THREE.HemisphereLight("#dff7bd", "#07110d", 1.9);
    scene.add(hemisphereLight);

    const sun = new THREE.DirectionalLight("#f5ffd7", 2.4);
    sun.position.set(-36, 52, 20);
    scene.add(sun);

    const selectedLight = new THREE.PointLight("#d8f56a", 38, 190, 1.35);
    selectedLight.position.set(0, 10, 0);
    scene.add(selectedLight);

    const groundMaterial = new THREE.MeshStandardMaterial({
      color: "#0a1811",
      roughness: 0.94,
      metalness: 0.02,
    });
    const ground = new THREE.Mesh(
      createGroundGeometry(),
      groundMaterial,
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    const groundGlow = new THREE.Mesh(
      new THREE.CircleGeometry(GROUND_SIZE * 0.48, 96),
      new THREE.MeshStandardMaterial({
        color: "#14331f",
        emissive: "#1d5a2d",
        emissiveIntensity: 0.16,
        roughness: 1,
        transparent: true,
        opacity: 0.2,
      }),
    );
    groundGlow.rotation.x = -Math.PI / 2;
    groundGlow.position.y = 0.04;
    scene.add(groundGlow);

    const grid = new THREE.GridHelper(GROUND_SIZE * 0.92, 108, "#33513d", "#173023");
    grid.position.y = 0.018;
    scene.add(grid);

    const boundary = POSITION_WORLD_SIZE * 0.72;
    const mountainGroup = new THREE.Group();
    scene.add(mountainGroup);

    const mountainEntries = repositories.map((repository) => {
      const geometry = terraWalkGeometry(repository, year);
      const selected = repository.id === selectedIdRef.current;
      const dimmed = !repositoryHasLanguage(repository, language);
      const color = new THREE.Color(repository.color);
      const material = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: selected ? 0.26 : dimmed ? 0.035 : 0.08,
        roughness: 0.9,
        metalness: 0.015,
        transparent: true,
        opacity: selected ? 0.98 : dimmed ? 0.2 : 0.88,
        flatShading: true,
        vertexColors: true,
        side: THREE.DoubleSide,
      });
      const mountain = new THREE.Mesh(createMountainMeshGeometry(repository, geometry), material);
      mountain.position.set(geometry.x, 0, geometry.z);
      mountainGroup.add(mountain);

      const wireframeMaterial = new THREE.LineBasicMaterial({
        color: "#101811",
        transparent: true,
        opacity: selected ? 0.24 : dimmed ? 0.035 : 0.15,
        depthWrite: false,
      });
      const wireframe = new THREE.LineSegments(new THREE.WireframeGeometry(mountain.geometry), wireframeMaterial);
      wireframe.position.set(geometry.x, 0.4, geometry.z);
      mountainGroup.add(wireframe);

      const foothillMaterial = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: selected ? 0.2 : dimmed ? 0.04 : 0.12,
        depthWrite: false,
      });
      const foothill = new THREE.Mesh(new THREE.CircleGeometry(1, 96), foothillMaterial);
      foothill.scale.set(geometry.radiusX * 1.42, geometry.radiusZ * 1.52, 1);
      foothill.rotation.x = -Math.PI / 2;
      foothill.position.set(geometry.x, 0.1, geometry.z);
      mountainGroup.add(foothill);

      const contourMaterial = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: selected ? 0.52 : dimmed ? 0.06 : 0.24,
      });
      const contours = new THREE.Group();
      for (let ring = 1; ring <= 6; ring += 1) {
        const y = (ring / 7) * geometry.height;
        const radiusX = geometry.radiusX * (1 - ring / 7) + 0.15;
        const radiusZ = geometry.radiusZ * (1 - ring / 7) + 0.15;
        const points: THREE.Vector3[] = [];
        for (let segment = 0; segment <= 80; segment += 1) {
          const angle = (segment / 80) * Math.PI * 2;
          points.push(new THREE.Vector3(
            Math.cos(angle) * radiusX,
            y,
            Math.sin(angle) * radiusZ,
          ));
        }
        const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), contourMaterial);
        contours.add(line);
      }
      contours.position.set(geometry.x, 0.08, geometry.z);
      mountainGroup.add(contours);

      return { repository, dimmed, ...geometry, mountain, wireframe, contours, foothill, material, wireframeMaterial, contourMaterial, foothillMaterial };
    });

    const grassField = createGrassField(mountainEntries);
    grassField.position.y = 0.04;
    scene.add(grassField);

    let yaw = 0;
    let pitch = 0;
    const keys = new Set<WalkKey>();
    const clock = new THREE.Clock();
    let animationFrame = 0;
    let currentNearestId = "";
    let lastPositionReport = 0;
    let readyReported = false;

    const setCameraRotation = () => {
      camera.rotation.set(pitch, yaw, 0);
    };

    const selectedEntry = mountainEntries.find((entry) => entry.repository.id === selectedIdRef.current) ?? mountainEntries[0];
    const spawnPosition = initialPositionRef.current;
    if (spawnPosition) {
      const spawn = atlasPositionToWalkWorld(spawnPosition);
      const spawnX = Math.max(-boundary, Math.min(boundary, spawn.x));
      const spawnZ = Math.max(-boundary, Math.min(boundary, spawn.z));
      camera.position.set(
        spawnX,
        walkSurfaceHeightAt(spawnX, spawnZ, mountainEntries) + EYE_HEIGHT,
        spawnZ,
      );
      yaw = 0;
      pitch = -0.08;
    } else if (selectedEntry) {
      const spawnX = Math.max(-boundary, Math.min(boundary, selectedEntry.x));
      const spawnZ = Math.min(boundary, selectedEntry.z + selectedEntry.radiusZ + 620);
      camera.position.set(
        spawnX,
        walkSurfaceHeightAt(spawnX, spawnZ, mountainEntries) + EYE_HEIGHT,
        spawnZ,
      );
      yaw = 0;
      pitch = -0.08;
    }

    const reportWalkPosition = () => {
      onPositionChangeRef.current?.(walkWorldToAtlasPosition(camera.position.x, camera.position.z));
    };

    const syncSelectedVisuals = () => {
      mountainEntries.forEach((entry) => {
        const selected = entry.repository.id === selectedIdRef.current;
        entry.material.emissiveIntensity = selected ? 0.3 : entry.dimmed ? 0.035 : 0.08;
        entry.material.opacity = selected ? 0.98 : entry.dimmed ? 0.2 : 0.88;
        entry.wireframeMaterial.opacity = selected ? 0.24 : entry.dimmed ? 0.035 : 0.15;
        entry.contourMaterial.opacity = selected ? 0.58 : entry.dimmed ? 0.06 : 0.24;
        entry.foothillMaterial.opacity = selected ? 0.22 : entry.dimmed ? 0.04 : 0.12;
      });
    };

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    const handlePointerLockChange = () => {
      setPointerLocked(document.pointerLockElement === renderer.domElement);
    };

    const handleCanvasClick = () => {
      renderer.domElement.requestPointerLock();
    };

    const handleMouseMove = (event: MouseEvent) => {
      if (document.pointerLockElement !== renderer.domElement) return;
      yaw -= event.movementX * 0.0022;
      pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch - event.movementY * 0.0022));
      setCameraRotation();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const key = movementKey(event.key.toLowerCase());
      if (!key) return;
      keys.add(key);
      event.preventDefault();
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const key = movementKey(event.key.toLowerCase());
      if (key) keys.delete(key);
    };

    renderer.domElement.addEventListener("click", handleCanvasClick);
    document.addEventListener("pointerlockchange", handlePointerLockChange);
    document.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    const animate = () => {
      const delta = Math.min(0.05, clock.getDelta());
      const grassTime = grassField.material.uniforms.uTime;
      if (grassTime) grassTime.value = clock.elapsedTime;
      const speed = (keys.has("run") ? 290 : 138) * delta;
      let forward = 0;
      let strafe = 0;
      if (keys.has("forward")) forward += 1;
      if (keys.has("backward")) forward -= 1;
      if (keys.has("right")) strafe += 1;
      if (keys.has("left")) strafe -= 1;

      if (forward || strafe) {
        const length = Math.hypot(forward, strafe) || 1;
        forward /= length;
        strafe /= length;
        const attemptedX = camera.position.x + (-Math.sin(yaw) * forward + Math.cos(yaw) * strafe) * speed;
        const attemptedZ = camera.position.z + (-Math.cos(yaw) * forward - Math.sin(yaw) * strafe) * speed;
        const clampedAttemptX = Math.max(-boundary, Math.min(boundary, attemptedX));
        const clampedAttemptZ = Math.max(-boundary, Math.min(boundary, attemptedZ));
        camera.position.x = clampedAttemptX;
        camera.position.z = clampedAttemptZ;
      }
      const targetEyeHeight = walkSurfaceHeightAt(camera.position.x, camera.position.z, mountainEntries) + EYE_HEIGHT;
      camera.position.y += (targetEyeHeight - camera.position.y) * Math.min(1, delta * 16);

      const now = performance.now();
      if (now - lastPositionReport > POSITION_REPORT_INTERVAL) {
        lastPositionReport = now;
        reportWalkPosition();
      }

      let nearest = mountainEntries[0] ?? null;
      let nearestDistance = Number.POSITIVE_INFINITY;
      mountainEntries.forEach((entry) => {
        const distance = Math.hypot(camera.position.x - entry.x, camera.position.z - entry.z);
        if (distance < nearestDistance) {
          nearest = entry;
          nearestDistance = distance;
        }
      });

      if (nearest && nearest.repository.id !== currentNearestId) {
        currentNearestId = nearest.repository.id;
        setNearestRepository(nearest.repository);
        onSelectRef.current(nearest.repository.id);
        selectedIdRef.current = nearest.repository.id;
        selectedLight.position.set(nearest.x, nearest.height + 4, nearest.z);
        syncSelectedVisuals();
      }

      renderer.render(scene, camera);
      if (!readyReported) {
        readyReported = true;
        setSceneReady(true);
        onReadyRef.current?.();
      }
      animationFrame = requestAnimationFrame(animate);
    };

    setCameraRotation();
    reportWalkPosition();
    syncSelectedVisuals();
    animate();

    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("click", handleCanvasClick);
      document.removeEventListener("pointerlockchange", handlePointerLockChange);
      document.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
      reportWalkPosition();
      scene.remove(grassField);
      host.removeChild(renderer.domElement);
      disposeObject(scene);
      renderer.dispose();
    };
  }, [language, repositories, year]);

  return (
    <section className="walk-mode-scene" aria-label="First person terrain walk mode">
      <div ref={hostRef} className="walk-mode-canvas-host" />
      {!sceneReady && (
        <div className="walk-mode-loading" role="status" aria-live="polite">
          <span className="walk-mode-loading-orbit" aria-hidden="true"/>
          <p>Preparing Walk Mode</p>
          <strong>Growing grass field</strong>
          <small>Reusing cached terrain when available</small>
        </div>
      )}
      <span className="walk-reticle" aria-hidden="true" />
      <div className="walk-mode-hud">
        <p>WALK MODE / FIRST PERSON</p>
        <strong>{nearestRepository?.name ?? "Enter the terrain"}</strong>
        <span>{nearestRepository ? `${nearestRepository.language} / ${compactNumber(nearestRepository.lines)} LOC` : "Click the scene, then walk with WASD"}</span>
      </div>
      {!pointerLocked && (
        <button type="button" className="walk-mode-prompt" onClick={() => hostRef.current?.querySelector("canvas")?.requestPointerLock()}>
          Click to walk
          <span>WASD to move / Mouse to look / Esc to release</span>
        </button>
      )}
    </section>
  );
}
