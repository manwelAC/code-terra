import * as THREE from "three";
import type { TerrainRepository } from "@/lib/repositories";

type RepositoryTerrainGeometry = {
  radiusX: number;
  radiusZ: number;
  height: number;
};

const LOW_GRASS = new THREE.Color("#405b2a");
const HIGHLAND = new THREE.Color("#798247");
const DRY_RIDGE = new THREE.Color("#aa9562");
const ROCK = new THREE.Color("#d4ccb0");

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const progress = clamp((value - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
  return progress * progress * (3 - 2 * progress);
}

function seededNoise(seed: number, x: number, z: number) {
  const value = Math.sin(seed * 83.17 + x * 19.91 + z * 47.13) * 43758.5453;
  return (value - Math.floor(value)) * 2 - 1;
}

function localHeight(repository: TerrainRepository, nx: number, nz: number, maxHeight: number) {
  const distance = Math.hypot(nx, nz);
  if (distance > 1.22) return 0;

  const edgeFade = 1 - smoothstep(0.82, 1.22, distance);
  const mesa = (1 - smoothstep(0.08, 1.04, distance)) * 0.18;
  const peakA = Math.exp(-((nx - 0.18) ** 2 * 5.5 + (nz + 0.12) ** 2 * 3.2)) * 0.72;
  const peakB = Math.exp(-((nx + 0.36) ** 2 * 4.2 + (nz - 0.28) ** 2 * 5.4)) * 0.42;
  const peakC = Math.exp(-((nx - 0.24) ** 2 * 8.8 + (nz + 0.48) ** 2 * 4.2)) * 0.22;
  const ridge = Math.exp(-(Math.abs(nz + Math.sin(nx * 3.1 + repository.seed) * 0.18) * 4.4 + nx * nx * 0.72)) * 0.35;
  const ravines = Math.max(0, Math.sin(nx * 15.5 + repository.seed * 0.19) + Math.cos(nz * 13.2)) * 0.038;
  const roughness = seededNoise(repository.seed, Math.round(nx * 42), Math.round(nz * 42)) * 0.035;

  return maxHeight * Math.max(0, (mesa + peakA + peakB + peakC + ridge + roughness - ravines) * edgeFade);
}

export function repositoryTerrainHeightAt(
  repository: TerrainRepository,
  geometry: RepositoryTerrainGeometry,
  localX: number,
  localZ: number,
) {
  return localHeight(
    repository,
    localX / Math.max(1, geometry.radiusX),
    localZ / Math.max(1, geometry.radiusZ),
    geometry.height,
  );
}

export function createRepositoryTerrainGeometry(repository: TerrainRepository, geometry: RepositoryTerrainGeometry) {
  const width = geometry.radiusX * 2.62;
  const depth = geometry.radiusZ * 2.62;
  const columns = 72;
  const rows = 72;
  const vertices: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const elevations: number[] = [];
  const color = new THREE.Color();
  const repoTint = new THREE.Color(repository.color);

  for (let row = 0; row <= rows; row += 1) {
    const v = row / rows;
    const localZ = (v - 0.5) * depth;

    for (let column = 0; column <= columns; column += 1) {
      const u = column / columns;
      const localX = (u - 0.5) * width;
      const elevation = repositoryTerrainHeightAt(repository, geometry, localX, localZ);
      const normalizedHeight = clamp(elevation / Math.max(1, geometry.height), 0, 1);
      const ridgeNoise = seededNoise(repository.seed + 11, column, row);

      if (normalizedHeight < 0.18) color.copy(LOW_GRASS).lerp(HIGHLAND, normalizedHeight / 0.18);
      else if (normalizedHeight < 0.58) color.copy(HIGHLAND).lerp(DRY_RIDGE, (normalizedHeight - 0.18) / 0.4);
      else color.copy(DRY_RIDGE).lerp(ROCK, (normalizedHeight - 0.58) / 0.42);

      color.lerp(repoTint, 0.08 + normalizedHeight * 0.22);
      color.offsetHSL(0, 0, ridgeNoise * 0.035);
      vertices.push(localX, elevation, localZ);
      elevations.push(elevation);
      colors.push(color.r, color.g, color.b);
    }
  }

  const pushTriangle = (a: number, b: number, c: number) => {
    if (Math.max(elevations[a], elevations[b], elevations[c]) <= 0.04) return;
    indices.push(a, b, c);
  };

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const current = row * (columns + 1) + column;
      const next = current + 1;
      const below = current + columns + 1;
      const belowNext = below + 1;
      pushTriangle(current, below, next);
      pushTriangle(next, below, belowNext);
    }
  }

  const terrainGeometry = new THREE.BufferGeometry();
  terrainGeometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  terrainGeometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  terrainGeometry.setIndex(indices);
  terrainGeometry.computeVertexNormals();
  return terrainGeometry;
}
