"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { compactNumber, repositoryHasLanguage, type LanguageFilter, type TerrainRepository } from "@/lib/repositories";

type WalkModeSceneProps = {
  repositories: TerrainRepository[];
  selectedId: string;
  year: number;
  language: LanguageFilter;
  onSelect: (id: string) => void;
};

type WalkKey = "forward" | "backward" | "left" | "right" | "run";

const POSITION_WORLD_SIZE = 1750;
const TERRAIN_WORLD_SIZE = 620;
const EYE_HEIGHT = 5.8;
const MAX_PITCH = Math.PI * 0.42;
const GROUND_SIZE = POSITION_WORLD_SIZE * 1.56;

type WalkTerrainGeometry = {
  x: number;
  z: number;
  radiusX: number;
  radiusZ: number;
  height: number;
  growth: number;
};

function seededTerrainNoise(seed: number, segment: number, ring: number) {
  const value = Math.sin(seed * 81.71 + segment * 19.91 + ring * 47.13) * 43758.5453;
  return (value - Math.floor(value)) * 2 - 1;
}

function terraGrowth(repository: TerrainRepository, year: number) {
  return Math.min(1, 0.48 + (year - repository.created) * 0.13);
}

function terraWalkGeometry(repository: TerrainRepository, year: number) {
  const growth = terraGrowth(repository, year);
  const radiusX = TERRAIN_WORLD_SIZE * 0.24 * repository.spread * growth;
  const radiusZ = radiusX * 0.86;
  const height = TERRAIN_WORLD_SIZE * (0.14 + 0.3 * repository.relief * growth);

  return {
    x: (repository.px - 0.5) * POSITION_WORLD_SIZE,
    z: (repository.py - 0.5) * POSITION_WORLD_SIZE,
    radiusX,
    radiusZ,
    height,
    growth,
  };
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
  const segments = 84;
  const rings = 13;
  const vertices: number[] = [];
  const indices: number[] = [];

  for (let ring = 0; ring <= rings; ring += 1) {
    const fraction = ring / rings;
    const radiusFraction = ring === 0 ? 0.08 : Math.pow(fraction, 0.66);
    const elevation = geometry.height * Math.pow(1 - Math.pow(fraction, 1.34), 1.06);
    const roughness = 0.008 + fraction * 0.028;

    for (let segment = 0; segment < segments; segment += 1) {
      const angle = (segment / segments) * Math.PI * 2;
      const edgeNoise = 1 + seededTerrainNoise(repository.seed, segment, ring) * roughness;
      const shoulderNoise = 1 + seededTerrainNoise(repository.seed + 17, segment, ring + 3) * 0.05;
      const radiusX = geometry.radiusX * radiusFraction * edgeNoise;
      const radiusZ = geometry.radiusZ * radiusFraction * shoulderNoise;
      vertices.push(Math.cos(angle) * radiusX, elevation, Math.sin(angle) * radiusZ);
    }
  }

  for (let ring = 0; ring < rings; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const current = ring * segments + segment;
      const next = ring * segments + ((segment + 1) % segments);
      const below = (ring + 1) * segments + segment;
      const belowNext = (ring + 1) * segments + ((segment + 1) % segments);
      indices.push(current, below, next, next, below, belowNext);
    }
  }

  const meshGeometry = new THREE.BufferGeometry();
  meshGeometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  meshGeometry.setIndex(indices);
  meshGeometry.computeVertexNormals();
  return meshGeometry;
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
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((item) => item.dispose());
    else material?.dispose();
  });
}

export default function WalkModeScene({ repositories, selectedId, year, language, onSelect }: WalkModeSceneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  const selectedIdRef = useRef(selectedId);
  const [pointerLocked, setPointerLocked] = useState(false);
  const [nearestRepository, setNearestRepository] = useState<TerrainRepository | null>(null);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#07110d");
    scene.fog = new THREE.FogExp2("#07110d", 0.00135);

    const camera = new THREE.PerspectiveCamera(64, 1, 0.1, 2600);
    camera.position.set(0, EYE_HEIGHT, 360);
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

    const selectedLight = new THREE.PointLight("#d8f56a", 32, 130, 1.4);
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

    const grid = new THREE.GridHelper(GROUND_SIZE * 0.92, 82, "#33513d", "#173023");
    grid.position.y = 0.018;
    scene.add(grid);

    const boundary = POSITION_WORLD_SIZE * 0.7;
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
        side: THREE.DoubleSide,
      });
      const mountain = new THREE.Mesh(createMountainMeshGeometry(repository, geometry), material);
      mountain.position.set(geometry.x, 0, geometry.z);
      mountainGroup.add(mountain);

      const foothillMaterial = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: selected ? 0.2 : dimmed ? 0.04 : 0.12,
        depthWrite: false,
      });
      const foothill = new THREE.Mesh(new THREE.CircleGeometry(1, 96), foothillMaterial);
      foothill.scale.set(geometry.radiusX * 1.75, geometry.radiusZ * 2.05, 1);
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

      return { repository, dimmed, ...geometry, mountain, contours, foothill, material, contourMaterial, foothillMaterial };
    });

    let yaw = 0;
    let pitch = 0;
    const keys = new Set<WalkKey>();
    const clock = new THREE.Clock();
    let animationFrame = 0;
    let currentNearestId = "";

    const setCameraRotation = () => {
      camera.rotation.set(pitch, yaw, 0);
    };

    const selectedEntry = mountainEntries.find((entry) => entry.repository.id === selectedIdRef.current) ?? mountainEntries[0];
    if (selectedEntry) {
      camera.position.set(
        selectedEntry.x,
        EYE_HEIGHT,
        Math.min(boundary, selectedEntry.z + selectedEntry.radiusZ + 165),
      );
      yaw = 0;
      pitch = -0.08;
    }

    const syncSelectedVisuals = () => {
      mountainEntries.forEach((entry) => {
        const selected = entry.repository.id === selectedIdRef.current;
        entry.material.emissiveIntensity = selected ? 0.3 : entry.dimmed ? 0.035 : 0.08;
        entry.material.opacity = selected ? 0.98 : entry.dimmed ? 0.2 : 0.88;
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
      const speed = (keys.has("run") ? 185 : 88) * delta;
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
        camera.position.x += (-Math.sin(yaw) * forward + Math.cos(yaw) * strafe) * speed;
        camera.position.z += (-Math.cos(yaw) * forward - Math.sin(yaw) * strafe) * speed;
        camera.position.x = Math.max(-boundary, Math.min(boundary, camera.position.x));
        camera.position.z = Math.max(-boundary, Math.min(boundary, camera.position.z));
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
      animationFrame = requestAnimationFrame(animate);
    };

    setCameraRotation();
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
      host.removeChild(renderer.domElement);
      disposeObject(scene);
      renderer.dispose();
    };
  }, [language, repositories, year]);

  return (
    <section className="walk-mode-scene" aria-label="First person terrain walk mode">
      <div ref={hostRef} className="walk-mode-canvas-host" />
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
