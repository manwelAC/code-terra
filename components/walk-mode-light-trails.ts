import * as THREE from "three";
import type { TerrainRepository } from "@/lib/repositories";

type TrailTerrain = {
  x: number;
  z: number;
  radiusX: number;
  radiusZ: number;
  repository: TerrainRepository;
};

type LightTrailField = THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;

let lightTrailCache: { key: string; field: LightTrailField } | null = null;

function nextTrailRandom(state: { value: number }) {
  state.value = (Math.imul(1664525, state.value) + 1013904223) >>> 0;
  return state.value / 0xffffffff;
}

function disposeLightTrail(field: LightTrailField) {
  field.geometry.dispose();
  field.material.dispose();
}

function nearestTerrainColor(x: number, z: number, terrains: TrailTerrain[]) {
  let nearest = terrains[0] ?? null;
  let nearestScore = Number.POSITIVE_INFINITY;

  terrains.forEach((terrain) => {
    const dx = (x - terrain.x) / Math.max(1, terrain.radiusX * 1.15);
    const dz = (z - terrain.z) / Math.max(1, terrain.radiusZ * 1.15);
    const score = dx * dx + dz * dz;
    if (score < nearestScore) {
      nearest = terrain;
      nearestScore = score;
    }
  });

  const color = new THREE.Color(nearest?.repository.color ?? "#d8f56a");
  if (nearestScore > 1.15) color.lerp(new THREE.Color("#58e7c7"), 0.58);
  return color;
}

function makeTrailKey(terrains: TrailTerrain[], fieldSize: number) {
  const terrainSignature = [...terrains]
    .sort((a, b) => a.repository.id.localeCompare(b.repository.id))
    .map((terrain) => [
      terrain.repository.id,
      terrain.x.toFixed(1),
      terrain.z.toFixed(1),
      terrain.radiusX.toFixed(1),
      terrain.radiusZ.toFixed(1),
    ].join(":"))
    .join("|");

  return `${fieldSize.toFixed(1)}:${terrainSignature}`;
}

export function createCachedLightTrails(terrains: TrailTerrain[], fieldSize: number) {
  const key = makeTrailKey(terrains, fieldSize);
  if (lightTrailCache?.key === key) {
    lightTrailCache.field.parent?.remove(lightTrailCache.field);
    return lightTrailCache.field;
  }

  if (lightTrailCache) {
    lightTrailCache.field.parent?.remove(lightTrailCache.field);
    disposeLightTrail(lightTrailCache.field);
    lightTrailCache = null;
  }

  const orderedTerrains = [...terrains].sort((a, b) => (
    Math.atan2(a.z, a.x) - Math.atan2(b.z, b.x)
      || a.repository.id.localeCompare(b.repository.id)
  ));
  const trailCount = Math.min(14, Math.max(7, Math.ceil(orderedTerrains.length / 5)));
  const samplesPerTrail = 320;
  const totalSamples = trailCount * samplesPerTrail;
  const positions = new Float32Array(totalSamples * 3);
  const colors = new Float32Array(totalSamples * 3);
  const progress = new Float32Array(totalSamples);
  const phases = new Float32Array(totalSamples);
  const sizes = new Float32Array(totalSamples);
  const color = new THREE.Color();
  const randomState = { value: 0x45d9f3b };
  const halfSize = fieldSize * 0.5;

  for (let trail = 0; trail < trailCount; trail += 1) {
    const lanePhase = nextTrailRandom(randomState) * Math.PI * 2;
    const laneRadius = halfSize * (0.26 + nextTrailRandom(randomState) * 0.58);
    const terrainOffset = Math.floor((trail / trailCount) * Math.max(1, orderedTerrains.length));

    for (let sample = 0; sample < samplesPerTrail; sample += 1) {
      const index = trail * samplesPerTrail + sample;
      const sampleProgress = sample / samplesPerTrail;
      const angle = sampleProgress * Math.PI * 2 + lanePhase;
      const terrain = orderedTerrains[(terrainOffset + sample) % Math.max(1, orderedTerrains.length)];
      const nextTerrain = orderedTerrains[(terrainOffset + sample + 1) % Math.max(1, orderedTerrains.length)];
      const terrainBlend = (sample * 0.035 + trail * 0.17) % 1;
      const terrainX = THREE.MathUtils.lerp(terrain?.x ?? 0, nextTerrain?.x ?? 0, terrainBlend);
      const terrainZ = THREE.MathUtils.lerp(terrain?.z ?? 0, nextTerrain?.z ?? 0, terrainBlend);
      const orbitX = Math.cos(angle) * laneRadius;
      const orbitZ = Math.sin(angle * (trail % 2 ? 0.82 : 1.08)) * laneRadius;
      const routeMix = 0.38 + Math.sin(sampleProgress * Math.PI * 2 + trail) * 0.08;
      const x = THREE.MathUtils.lerp(orbitX, terrainX, routeMix);
      const z = THREE.MathUtils.lerp(orbitZ, terrainZ, routeMix);
      const y = 18 + Math.sin(sampleProgress * Math.PI * 8 + trail) * 8 + nextTrailRandom(randomState) * 10;

      positions[index * 3] = x;
      positions[index * 3 + 1] = y;
      positions[index * 3 + 2] = z;

      color.copy(nearestTerrainColor(x, z, terrains));
      colors[index * 3] = color.r;
      colors[index * 3 + 1] = color.g;
      colors[index * 3 + 2] = color.b;

      progress[index] = sampleProgress;
      phases[index] = trail / trailCount + nextTrailRandom(randomState) * 0.08;
      sizes[index] = 4 + nextTrailRandom(randomState) * 8;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("aProgress", new THREE.BufferAttribute(progress, 1));
  geometry.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      },
    ]),
    vertexShader: `
      attribute float aProgress;
      attribute float aPhase;
      attribute float aSize;
      varying vec3 vColor;
      varying float vPulse;
      uniform float uTime;
      uniform float uPixelRatio;
      #include <fog_pars_vertex>

      void main() {
        vec3 transformed = position;
        float flow = fract(aProgress - uTime * 0.055 - aPhase);
        float head = smoothstep(0.0, 0.08, flow) * (1.0 - smoothstep(0.08, 0.34, flow));
        float wake = smoothstep(0.0, 0.42, flow) * (1.0 - smoothstep(0.42, 0.92, flow));
        transformed.y += sin(uTime * 1.2 + aProgress * 38.0 + aPhase * 20.0) * 1.8;

        vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
        float distanceScale = clamp(360.0 / max(1.0, -mvPosition.z), 0.22, 1.45);
        gl_PointSize = clamp(aSize * uPixelRatio * distanceScale * (0.48 + head * 1.35), 1.0, 14.0);
        gl_Position = projectionMatrix * mvPosition;

        vColor = color;
        vPulse = max(head, wake * 0.42);
        #include <fog_vertex>
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vPulse;
      #include <fog_pars_fragment>

      void main() {
        vec2 point = gl_PointCoord - 0.5;
        float glow = smoothstep(0.5, 0.04, length(point));
        if (glow <= 0.01 || vPulse <= 0.015) discard;
        gl_FragColor = vec4(vColor, glow * vPulse * 0.86);
        #include <fog_fragment>
      }
    `,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: true,
    transparent: true,
    vertexColors: true,
  });

  const trails = new THREE.Points(geometry, material);
  trails.name = "walk-mode-light-trails";
  trails.frustumCulled = false;
  trails.renderOrder = 4;
  trails.userData.preserveAcrossWalkMode = true;
  lightTrailCache = { key, field: trails };
  return trails;
}
