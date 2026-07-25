import * as THREE from "three";
import type { TerrainRepository } from "@/lib/repositories";

type CoreRoomOptions = {
  repository: TerrainRepository;
  radius: number;
  height: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function hashColor(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return new THREE.Color(`hsl(${hash % 360} 72% 58%)`);
}

function nextCoreRandom(state: { value: number }) {
  state.value = (Math.imul(1664525, state.value) + 1013904223) >>> 0;
  return state.value / 0xffffffff;
}

function createLineLoop(radius: number, y: number, color: THREE.ColorRepresentation, opacity: number) {
  const points: THREE.Vector3[] = [];
  for (let index = 0; index <= 96; index += 1) {
    const angle = (index / 96) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius));
  }

  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
}

function createWallVeins(repository: TerrainRepository, roomRadius: number, roomHeight: number) {
  const randomState = { value: repository.seed ^ 0x3467a12f };
  const points: THREE.Vector3[] = [];
  const veinCount = 34;

  for (let vein = 0; vein < veinCount; vein += 1) {
    const angle = nextCoreRandom(randomState) * Math.PI * 2;
    const startY = nextCoreRandom(randomState) * roomHeight * 0.85;
    const segmentCount = 2 + Math.floor(nextCoreRandom(randomState) * 3);
    let previous = new THREE.Vector3(
      Math.cos(angle) * roomRadius * 1.21,
      startY,
      Math.sin(angle) * roomRadius * 1.21,
    );

    for (let segment = 0; segment < segmentCount; segment += 1) {
      const nextAngle = angle + (nextCoreRandom(randomState) - 0.5) * 0.42;
      const nextY = previous.y + 12 + nextCoreRandom(randomState) * 34;
      const next = new THREE.Vector3(
        Math.cos(nextAngle) * roomRadius * (1.18 + nextCoreRandom(randomState) * 0.08),
        Math.min(roomHeight + 52, nextY),
        Math.sin(nextAngle) * roomRadius * (1.18 + nextCoreRandom(randomState) * 0.08),
      );
      points.push(previous, next);
      previous = next;
    }
  }

  const material = new THREE.LineBasicMaterial({
    color: "#58e7c7",
    transparent: true,
    opacity: 0.32,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const veins = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), material);
  veins.name = "core-room-pulse-material";
  veins.userData.pulseOpacity = { base: 0.2, range: 0.16, speed: 1.2, phase: repository.seed * 0.01 };
  return veins;
}

function createEnergyConduits(repository: TerrainRepository, roomRadius: number, roomHeight: number) {
  const group = new THREE.Group();
  const randomState = { value: repository.seed ^ 0x81f0c9ad };
  const coreY = roomHeight * 0.42;

  for (let index = 0; index < 7; index += 1) {
    const angle = (index / 7) * Math.PI * 2 + nextCoreRandom(randomState) * 0.28;
    const source = new THREE.Vector3(
      Math.cos(angle) * roomRadius * 0.92,
      8 + nextCoreRandom(randomState) * 70,
      Math.sin(angle) * roomRadius * 0.92,
    );
    const mid = new THREE.Vector3(
      Math.cos(angle + 0.45) * roomRadius * 0.54,
      coreY + (nextCoreRandom(randomState) - 0.5) * 58,
      Math.sin(angle + 0.45) * roomRadius * 0.54,
    );
    const target = new THREE.Vector3(
      Math.cos(angle + Math.PI) * 22,
      coreY + (nextCoreRandom(randomState) - 0.5) * 18,
      Math.sin(angle + Math.PI) * 22,
    );
    const curve = new THREE.QuadraticBezierCurve3(source, mid, target);
    const material = new THREE.LineBasicMaterial({
      color: index % 2 ? "#d8f56a" : "#58e7c7",
      transparent: true,
      opacity: 0.28,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const conduit = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(32)), material);
    conduit.name = "core-room-pulse-material";
    conduit.userData.pulseOpacity = { base: 0.14, range: 0.2, speed: 1.8 + index * 0.13, phase: index * 0.7 };
    group.add(conduit);
  }

  return group;
}

function createCorePedestal(repoColor: THREE.Color, accent: THREE.Color, roomRadius: number, roomHeight: number) {
  const group = new THREE.Group();
  const coreY = roomHeight * 0.42;
  const baseMaterial = new THREE.MeshBasicMaterial({
    color: repoColor.clone().lerp(new THREE.Color("#07110d"), 0.34),
    transparent: true,
    opacity: 0.34,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });

  const base = new THREE.Mesh(new THREE.CylinderGeometry(roomRadius * 0.36, roomRadius * 0.48, 16, 72, 1, true), baseMaterial);
  base.position.y = 8;
  group.add(base);

  const plinth = new THREE.Mesh(
    new THREE.CylinderGeometry(roomRadius * 0.22, roomRadius * 0.31, coreY * 0.72, 72, 1, true),
    new THREE.MeshBasicMaterial({
      color: accent,
      transparent: true,
      opacity: 0.08,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    }),
  );
  plinth.name = "core-room-pulse-material";
  plinth.userData.pulseOpacity = { base: 0.05, range: 0.055, speed: 1.1, phase: 0 };
  plinth.position.y = coreY * 0.38;
  group.add(plinth);

  [0.2, 0.31, 0.43].forEach((scale, index) => {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(roomRadius * scale, 1.2, 8, 96),
      new THREE.MeshBasicMaterial({
        color: index % 2 ? repoColor : accent,
        transparent: true,
        opacity: 0.42 - index * 0.08,
        depthTest: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    ring.name = "core-room-spin";
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 18 + index * 19;
    ring.userData.spinSpeed = index % 2 ? -0.22 : 0.25;
    group.add(ring);
  });

  return group;
}

function createTerrainInteriorShell(repository: TerrainRepository, roomRadius: number, roomHeight: number) {
  const radialSegments = 20;
  const heightSegments = 6;
  const randomState = { value: repository.seed ^ 0x7a5f2d31 };
  const vertices: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const baseColor = new THREE.Color(repository.color);
  const darkColor = new THREE.Color("#08130e");
  const color = new THREE.Color();

  for (let yIndex = 0; yIndex <= heightSegments; yIndex += 1) {
    const progress = yIndex / heightSegments;
    const y = -18 + progress * (roomHeight + 92);
    const taper = 1 - Math.abs(progress - 0.42) * 0.22;

    for (let radialIndex = 0; radialIndex <= radialSegments; radialIndex += 1) {
      const angle = (radialIndex / radialSegments) * Math.PI * 2;
      const ridge = Math.sin(angle * 3 + repository.seed * 0.07) * 0.08
        + Math.cos(angle * 5 - progress * 2.7) * 0.055
        + (nextCoreRandom(randomState) - 0.5) * 0.09;
      const radius = roomRadius * (1.34 + ridge) * taper;

      vertices.push(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
      color.copy(darkColor).lerp(baseColor, 0.18 + progress * 0.1 + Math.max(0, ridge) * 0.5);
      colors.push(color.r, color.g, color.b);
    }
  }

  for (let yIndex = 0; yIndex < heightSegments; yIndex += 1) {
    for (let radialIndex = 0; radialIndex < radialSegments; radialIndex += 1) {
      const current = yIndex * (radialSegments + 1) + radialIndex;
      const next = current + 1;
      const above = current + radialSegments + 1;
      const aboveNext = above + 1;
      indices.push(current, next, above, next, aboveNext, above);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const shell = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color: "#ffffff",
      vertexColors: true,
      transparent: true,
      opacity: 0.68,
      depthTest: true,
      depthWrite: true,
      side: THREE.BackSide,
    }),
  );
  shell.name = "core-room-shell";

  const createCapMaterial = () => new THREE.MeshBasicMaterial({
      color: baseColor.clone().lerp(darkColor, 0.72),
      transparent: true,
      opacity: 0.62,
      depthTest: true,
      depthWrite: true,
      side: THREE.DoubleSide,
    });

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(roomRadius * 1.18, 20),
    createCapMaterial(),
  );
  floor.name = "core-room-shell";
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -16;

  const ceiling = new THREE.Mesh(
    new THREE.CircleGeometry(roomRadius * 1.08, 20),
    createCapMaterial(),
  );
  ceiling.name = "core-room-shell";
  ceiling.rotation.x = -Math.PI / 2;
  ceiling.position.y = roomHeight + 70;

  const group = new THREE.Group();
  group.name = "core-room-shell";
  group.add(shell, floor, ceiling);
  return group;
}

function createCoreNodes(repository: TerrainRepository, roomRadius: number) {
  const nodeCount = clamp(Math.round(Math.sqrt(repository.files) * 2.2), 16, 72);
  const randomState = { value: repository.seed ^ 0x4f1bbcdc };
  const positions = new Float32Array(nodeCount * 3);
  const sizes = new Float32Array(nodeCount);
  const phases = new Float32Array(nodeCount);

  for (let index = 0; index < nodeCount; index += 1) {
    const angle = nextCoreRandom(randomState) * Math.PI * 2;
    const radius = roomRadius * (0.28 + nextCoreRandom(randomState) * 0.52);
    positions[index * 3] = Math.cos(angle) * radius;
    positions[index * 3 + 1] = 26 + nextCoreRandom(randomState) * 128;
    positions[index * 3 + 2] = Math.sin(angle) * radius;
    sizes[index] = 5 + nextCoreRandom(randomState) * 8;
    phases[index] = nextCoreRandom(randomState) * Math.PI * 2;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(repository.color) },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    },
    vertexShader: `
      attribute float aSize;
      attribute float aPhase;
      varying float vPulse;
      uniform float uTime;
      uniform float uPixelRatio;

      void main() {
        vec3 transformed = position;
        transformed.y += sin(uTime * 0.8 + aPhase) * 3.5;
        vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
        gl_PointSize = clamp(aSize * uPixelRatio * (360.0 / max(1.0, -mvPosition.z)), 2.0, 12.0);
        gl_Position = projectionMatrix * mvPosition;
        vPulse = 0.42 + 0.58 * sin(uTime * 1.8 + aPhase);
      }
    `,
    fragmentShader: `
      varying float vPulse;
      uniform vec3 uColor;

      void main() {
        vec2 point = gl_PointCoord - 0.5;
        float glow = smoothstep(0.5, 0.04, length(point));
        if (glow <= 0.01) discard;
        vec3 color = mix(vec3(0.86, 1.0, 0.54), uColor, 0.42);
        gl_FragColor = vec4(color, glow * (0.28 + vPulse * 0.58));
      }
    `,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });

  const nodes = new THREE.Points(geometry, material);
  nodes.name = "core-room-nodes";
  nodes.userData.coreRoomNodeField = true;
  return nodes;
}

function createChamberMotes(repository: TerrainRepository, roomRadius: number, roomHeight: number) {
  const moteCount = 120;
  const randomState = { value: repository.seed ^ 0x2df6a2b9 };
  const positions = new Float32Array(moteCount * 3);
  const sizes = new Float32Array(moteCount);
  const phases = new Float32Array(moteCount);

  for (let index = 0; index < moteCount; index += 1) {
    const angle = nextCoreRandom(randomState) * Math.PI * 2;
    const radius = Math.sqrt(nextCoreRandom(randomState)) * roomRadius * 0.94;
    positions[index * 3] = Math.cos(angle) * radius;
    positions[index * 3 + 1] = 6 + nextCoreRandom(randomState) * (roomHeight + 46);
    positions[index * 3 + 2] = Math.sin(angle) * radius;
    sizes[index] = 2.5 + nextCoreRandom(randomState) * 5.5;
    phases[index] = nextCoreRandom(randomState) * Math.PI * 2;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    },
    vertexShader: `
      attribute float aSize;
      attribute float aPhase;
      uniform float uTime;
      uniform float uPixelRatio;
      varying float vGlow;

      void main() {
        vec3 transformed = position;
        transformed.x += sin(uTime * 0.18 + aPhase) * 3.0;
        transformed.y += cos(uTime * 0.22 + aPhase) * 2.0;
        transformed.z += cos(uTime * 0.16 + aPhase * 1.3) * 2.8;
        vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
        gl_PointSize = clamp(aSize * uPixelRatio * (260.0 / max(1.0, -mvPosition.z)), 1.0, 7.0);
        gl_Position = projectionMatrix * mvPosition;
        vGlow = 0.45 + 0.55 * sin(uTime * 0.9 + aPhase);
      }
    `,
    fragmentShader: `
      varying float vGlow;

      void main() {
        vec2 point = gl_PointCoord - 0.5;
        float glow = smoothstep(0.5, 0.04, length(point));
        if (glow <= 0.01) discard;
        gl_FragColor = vec4(vec3(0.92, 1.0, 0.62), glow * (0.12 + vGlow * 0.22));
      }
    `,
    blending: THREE.AdditiveBlending,
    depthTest: true,
    depthWrite: false,
    transparent: true,
  });

  const motes = new THREE.Points(geometry, material);
  motes.name = "core-room-motes";
  motes.userData.coreRoomMotes = true;
  return motes;
}

export function createRepositoryCoreRoom({ repository, radius, height }: CoreRoomOptions) {
  const group = new THREE.Group();
  group.name = `repository-core-room:${repository.id}`;
  const roomRadius = clamp(radius * 0.2, 96, 142);
  const roomHeight = clamp(height * 0.42, 104, 170);
  const accent = new THREE.Color("#d8f56a");
  const repoColor = new THREE.Color(repository.color);

  group.add(createTerrainInteriorShell(repository, roomRadius, roomHeight));
  group.add(createWallVeins(repository, roomRadius, roomHeight));

  const floor = new THREE.Mesh(
    new THREE.RingGeometry(roomRadius * 0.18, roomRadius, 128),
    new THREE.MeshBasicMaterial({
      color: repoColor,
      transparent: true,
      opacity: 0.055,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    }),
  );
  floor.name = "core-room-spin";
  floor.rotation.x = -Math.PI / 2;
  floor.userData.spinSpeed = 0.025;
  group.add(floor);

  [0, roomHeight * 0.34, roomHeight * 0.68, roomHeight].forEach((y, index) => {
    const ring = createLineLoop(roomRadius * (1 - index * 0.07), y, index % 2 ? repoColor : accent, index === 0 ? 0.42 : 0.2);
    ring.name = "core-room-spin";
    ring.userData.spinSpeed = 0.045 + index * 0.02;
    group.add(ring);
  });

  const pillarPoints: THREE.Vector3[] = [];
  for (let index = 0; index < 10; index += 1) {
    const angle = (index / 10) * Math.PI * 2;
    const x = Math.cos(angle) * roomRadius;
    const z = Math.sin(angle) * roomRadius;
    pillarPoints.push(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, roomHeight, z));
  }
  group.add(new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(pillarPoints),
    new THREE.LineBasicMaterial({
      color: "#58e7c7",
      transparent: true,
      opacity: 0.16,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  ));

  const languageEntries = Object.entries(repository.languageBreakdown ?? {})
    .sort(([, bytesA], [, bytesB]) => bytesB - bytesA)
    .slice(0, 5);
  const languageTotal = languageEntries.reduce((sum, [, bytes]) => sum + bytes, 0) || 1;
  const strataEntries = languageEntries.length ? languageEntries : [[repository.language, 1] as [string, number]];
  let strataY = 10;
  strataEntries.forEach(([language, bytes], index) => {
    const thickness = clamp((bytes / languageTotal) * roomHeight * 0.34, 7, 28);
    const materialColor = index === 0 ? repoColor : hashColor(language);
    const strata = new THREE.Mesh(
      new THREE.CylinderGeometry(roomRadius * (0.3 + index * 0.035), roomRadius * (0.34 + index * 0.035), thickness, 64, 1, true),
      new THREE.MeshBasicMaterial({
        color: materialColor,
        transparent: true,
        opacity: 0.045,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    );
    strata.name = "core-room-strata";
    strata.position.y = strataY + thickness / 2;
    strata.userData.spinSpeed = index % 2 ? -0.08 : 0.08;
    group.add(strata);
    strataY += thickness + 5;
  });

  const commitRingCount = clamp(Math.round(Math.log10(Math.max(10, repository.commits)) * 2), 3, 8);
  for (let index = 0; index < commitRingCount; index += 1) {
    const ring = createLineLoop(roomRadius * (0.32 + index * 0.052), 30 + index * 13, accent, 0.15 + index * 0.018);
    ring.name = "core-room-spin";
    ring.rotation.z = index * 0.34;
    ring.userData.spinSpeed = index % 2 ? -0.18 : 0.15;
    group.add(ring);
  }

  group.add(createEnergyConduits(repository, roomRadius, roomHeight));
  group.add(createCorePedestal(repoColor, accent, roomRadius, roomHeight));

  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(26, 3),
    new THREE.MeshBasicMaterial({
      color: accent,
      transparent: true,
      opacity: 0.72,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      wireframe: true,
    }),
  );
  core.name = "core-room-core";
  core.position.y = roomHeight * 0.42;
  group.add(core);

  const coreGlow = new THREE.Mesh(
    new THREE.SphereGeometry(42, 32, 18),
    new THREE.MeshBasicMaterial({
      color: repoColor,
      transparent: true,
      opacity: 0.12,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  coreGlow.name = "core-room-core";
  coreGlow.userData.pulseOpacity = { base: 0.08, range: 0.08, speed: 1.45, phase: 0.5 };
  coreGlow.position.copy(core.position);
  group.add(coreGlow);

  group.add(createCoreNodes(repository, roomRadius));
  group.add(createChamberMotes(repository, roomRadius, roomHeight));
  group.userData.coreRoom = true;
  group.userData.walkRadius = roomRadius * 0.82;
  group.userData.spawnOffset = roomRadius * 0.46;
  group.userData.eyeHeight = clamp(roomHeight * 0.48, 64, 82);
  return group;
}

export function animateRepositoryCoreRoom(room: THREE.Group, time: number, delta: number) {
  room.traverse((child) => {
    if (typeof child.userData.spinSpeed === "number") child.rotation.y += delta * child.userData.spinSpeed;
    if (child.userData.pulseOpacity) {
      const pulse = child.userData.pulseOpacity as { base: number; range: number; speed: number; phase: number };
      const material = (child as THREE.Mesh | THREE.Line | THREE.LineSegments).material as THREE.Material & { opacity?: number };
      if (typeof material.opacity === "number") {
        material.opacity = pulse.base + (0.5 + Math.sin(time * pulse.speed + pulse.phase) * 0.5) * pulse.range;
      }
    }
    if (child.name === "core-room-core") {
      child.rotation.x += delta * 0.28;
      child.rotation.y += delta * 0.42;
      child.scale.setScalar(1 + Math.sin(time * 2.2) * 0.08);
    }
    if (child.name === "core-room-strata" && typeof child.userData.spinSpeed === "number") {
      child.rotation.y += delta * child.userData.spinSpeed;
    }
    if (child.userData.coreRoomNodeField) {
      const nodes = child as THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
      nodes.material.uniforms.uTime.value = time;
      nodes.rotation.y += delta * 0.08;
    }
    if (child.userData.coreRoomMotes) {
      const motes = child as THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
      motes.material.uniforms.uTime.value = time;
      motes.rotation.y += delta * 0.018;
    }
  });
}
