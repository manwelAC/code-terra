import * as THREE from "three";

type FireflyFieldOptions = {
  count: number;
  fieldSize: number;
};

type FireflyField = THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;

let fireflyFieldCache: { key: string; field: FireflyField } | null = null;

function nextFireflyRandom(state: { value: number }) {
  state.value = (Math.imul(1664525, state.value) + 1013904223) >>> 0;
  return state.value / 0xffffffff;
}

function disposeFireflyField(field: FireflyField) {
  field.geometry.dispose();
  field.material.dispose();
}

export function createCachedFireflyField({ count, fieldSize }: FireflyFieldOptions) {
  const key = `${count}:${fieldSize.toFixed(1)}`;
  if (fireflyFieldCache?.key === key) {
    fireflyFieldCache.field.parent?.remove(fireflyFieldCache.field);
    return fireflyFieldCache.field;
  }

  if (fireflyFieldCache) {
    fireflyFieldCache.field.parent?.remove(fireflyFieldCache.field);
    disposeFireflyField(fireflyFieldCache.field);
    fireflyFieldCache = null;
  }

  const positions = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  const sizes = new Float32Array(count);
  const shades = new Float32Array(count);
  const randomState = { value: 0x9e3779b9 };
  const halfSize = fieldSize * 0.5;

  for (let index = 0; index < count; index += 1) {
    const radius = Math.sqrt(nextFireflyRandom(randomState)) * halfSize;
    const angle = nextFireflyRandom(randomState) * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const lowFloat = nextFireflyRandom(randomState);
    const canopyFloat = nextFireflyRandom(randomState);

    positions[index * 3] = x;
    positions[index * 3 + 1] = 10 + lowFloat * lowFloat * 42 + canopyFloat * 54;
    positions[index * 3 + 2] = z;
    phases[index] = nextFireflyRandom(randomState) * Math.PI * 2;
    sizes[index] = 2.2 + nextFireflyRandom(randomState) * 4.8;
    shades[index] = nextFireflyRandom(randomState);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("aShade", new THREE.BufferAttribute(shades, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      },
    ]),
    vertexShader: `
      attribute float aPhase;
      attribute float aSize;
      attribute float aShade;
      varying float vPulse;
      varying float vShade;
      uniform float uTime;
      uniform float uPixelRatio;
      #include <fog_pars_vertex>

      void main() {
        vec3 transformed = position;
        float drift = sin(uTime * 0.28 + aPhase) * (1.8 + aShade * 3.2);
        transformed.x += drift;
        transformed.y += sin(uTime * 0.42 + aPhase * 1.7) * (0.8 + aShade * 2.4);
        transformed.z += cos(uTime * 0.24 + aPhase * 1.3) * (1.4 + aShade * 2.8);

        vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
        float distanceScale = clamp(210.0 / max(1.0, -mvPosition.z), 0.26, 1.35);
        gl_PointSize = clamp(aSize * uPixelRatio * distanceScale, 1.0, 6.2);
        gl_Position = projectionMatrix * mvPosition;

        vPulse = 0.45 + 0.55 * sin(uTime * (1.4 + aShade * 2.2) + aPhase);
        vShade = aShade;
        #include <fog_vertex>
      }
    `,
    fragmentShader: `
      varying float vPulse;
      varying float vShade;
      #include <fog_pars_fragment>

      void main() {
        vec2 point = gl_PointCoord - 0.5;
        float distanceFromCenter = length(point);
        float core = smoothstep(0.48, 0.04, distanceFromCenter);
        if (core <= 0.01) discard;

        vec3 warm = vec3(1.0, 0.92, 0.45);
        vec3 cool = vec3(0.55, 1.0, 0.78);
        vec3 color = mix(warm, cool, smoothstep(0.25, 1.0, vShade));
        float alpha = core * (0.16 + vPulse * 0.58);
        gl_FragColor = vec4(color, alpha);
        #include <fog_fragment>
      }
    `,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: true,
    transparent: true,
  });

  const fireflies = new THREE.Points(geometry, material);
  fireflies.name = "walk-mode-fireflies";
  fireflies.frustumCulled = false;
  fireflies.renderOrder = 3;
  fireflies.userData.preserveAcrossWalkMode = true;
  fireflyFieldCache = { key, field: fireflies };
  return fireflies;
}
