import * as THREE from "three";

type StarFieldOptions = {
  count: number;
  fieldSize: number;
};

type StarField = THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;

let starFieldCache: { key: string; field: StarField } | null = null;

function nextStarRandom(state: { value: number }) {
  state.value = (Math.imul(1664525, state.value) + 1013904223) >>> 0;
  return state.value / 0xffffffff;
}

function disposeStarField(field: StarField) {
  field.geometry.dispose();
  field.material.dispose();
}

export function createCachedStarField({ count, fieldSize }: StarFieldOptions) {
  const key = `${count}:${fieldSize.toFixed(1)}`;
  if (starFieldCache?.key === key) {
    starFieldCache.field.parent?.remove(starFieldCache.field);
    return starFieldCache.field;
  }

  if (starFieldCache) {
    starFieldCache.field.parent?.remove(starFieldCache.field);
    disposeStarField(starFieldCache.field);
    starFieldCache = null;
  }

  const positions = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  const sizes = new Float32Array(count);
  const shades = new Float32Array(count);
  const randomState = { value: 0x51f15eED };
  const halfSize = fieldSize * 0.5;

  for (let index = 0; index < count; index += 1) {
    const radius = Math.sqrt(nextStarRandom(randomState)) * halfSize;
    const angle = nextStarRandom(randomState) * Math.PI * 2;
    const heightBand = nextStarRandom(randomState);

    positions[index * 3] = Math.cos(angle) * radius;
    positions[index * 3 + 1] = 980 + heightBand * heightBand * 1850;
    positions[index * 3 + 2] = Math.sin(angle) * radius;
    phases[index] = nextStarRandom(randomState) * Math.PI * 2;
    sizes[index] = 1.1 + nextStarRandom(randomState) * 2.8;
    shades[index] = nextStarRandom(randomState);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("aShade", new THREE.BufferAttribute(shades, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    },
    vertexShader: `
      attribute float aPhase;
      attribute float aSize;
      attribute float aShade;
      varying float vTwinkle;
      varying float vShade;
      uniform float uTime;
      uniform float uPixelRatio;

      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        float distanceScale = clamp(900.0 / max(1.0, -mvPosition.z), 0.18, 1.0);
        gl_PointSize = clamp(aSize * uPixelRatio * distanceScale, 0.7, 3.2);
        gl_Position = projectionMatrix * mvPosition;
        vTwinkle = 0.42 + 0.58 * sin(uTime * (0.8 + aShade * 2.4) + aPhase);
        vShade = aShade;
      }
    `,
    fragmentShader: `
      varying float vTwinkle;
      varying float vShade;

      void main() {
        vec2 point = gl_PointCoord - 0.5;
        float distanceFromCenter = length(point);
        float core = smoothstep(0.5, 0.02, distanceFromCenter);
        if (core <= 0.01) discard;

        vec3 cool = vec3(0.66, 0.92, 1.0);
        vec3 warm = vec3(1.0, 0.95, 0.66);
        vec3 color = mix(cool, warm, smoothstep(0.72, 1.0, vShade));
        gl_FragColor = vec4(color, core * (0.18 + vTwinkle * 0.62));
      }
    `,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });

  const stars = new THREE.Points(geometry, material);
  stars.name = "walk-mode-stars";
  stars.frustumCulled = false;
  stars.renderOrder = 1;
  stars.userData.preserveAcrossWalkMode = true;
  starFieldCache = { key, field: stars };
  return stars;
}
