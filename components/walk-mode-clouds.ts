import * as THREE from "three";

type CloudLayerOptions = {
  count: number;
  fieldSize: number;
};

type CloudLayer = THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;

let cloudLayerCache: { key: string; layer: CloudLayer } | null = null;

function nextCloudRandom(state: { value: number }) {
  state.value = (Math.imul(1664525, state.value) + 1013904223) >>> 0;
  return state.value / 0xffffffff;
}

function disposeCloudLayer(layer: CloudLayer) {
  layer.geometry.dispose();
  layer.material.dispose();
}

export function createCachedCloudLayer({ count, fieldSize }: CloudLayerOptions) {
  const key = `${count}:${fieldSize.toFixed(1)}`;
  if (cloudLayerCache?.key === key) {
    cloudLayerCache.layer.parent?.remove(cloudLayerCache.layer);
    return cloudLayerCache.layer;
  }

  if (cloudLayerCache) {
    cloudLayerCache.layer.parent?.remove(cloudLayerCache.layer);
    disposeCloudLayer(cloudLayerCache.layer);
    cloudLayerCache = null;
  }

  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);
  const densities = new Float32Array(count);
  const randomState = { value: 0xc2b2ae35 };
  const cloudCount = 34;
  const halfSize = fieldSize * 0.5;
  const cloudCenters = Array.from({ length: cloudCount }, () => {
    const radius = Math.sqrt(nextCloudRandom(randomState)) * halfSize;
    const angle = nextCloudRandom(randomState) * Math.PI * 2;
    return {
      x: Math.cos(angle) * radius,
      y: 560 + nextCloudRandom(randomState) * 360,
      z: Math.sin(angle) * radius,
      width: 260 + nextCloudRandom(randomState) * 520,
      depth: 150 + nextCloudRandom(randomState) * 360,
      height: 28 + nextCloudRandom(randomState) * 82,
    };
  });

  for (let index = 0; index < count; index += 1) {
    const center = cloudCenters[index % cloudCenters.length];
    const angle = nextCloudRandom(randomState) * Math.PI * 2;
    const radius = Math.sqrt(nextCloudRandom(randomState));
    const vertical = (nextCloudRandom(randomState) - 0.5) * center.height;

    positions[index * 3] = center.x + Math.cos(angle) * radius * center.width;
    positions[index * 3 + 1] = center.y + vertical;
    positions[index * 3 + 2] = center.z + Math.sin(angle) * radius * center.depth;
    sizes[index] = 34 + nextCloudRandom(randomState) * 108;
    phases[index] = nextCloudRandom(randomState) * Math.PI * 2;
    densities[index] = 0.42 + nextCloudRandom(randomState) * 0.58;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute("aDensity", new THREE.BufferAttribute(densities, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      },
    ]),
    vertexShader: `
      attribute float aSize;
      attribute float aPhase;
      attribute float aDensity;
      varying float vDensity;
      varying float vSoftness;
      uniform float uTime;
      uniform float uPixelRatio;
      #include <fog_pars_vertex>

      void main() {
        vec3 transformed = position;
        transformed.x += sin(uTime * 0.035 + aPhase) * 18.0;
        transformed.z += cos(uTime * 0.028 + aPhase * 1.4) * 14.0;

        vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
        float distanceScale = clamp(1050.0 / max(1.0, -mvPosition.z), 0.18, 1.0);
        gl_PointSize = clamp(aSize * uPixelRatio * distanceScale, 4.0, 80.0);
        gl_Position = projectionMatrix * mvPosition;

        vDensity = aDensity;
        vSoftness = 0.72 + 0.28 * sin(uTime * 0.08 + aPhase);
        #include <fog_vertex>
      }
    `,
    fragmentShader: `
      varying float vDensity;
      varying float vSoftness;
      #include <fog_pars_fragment>

      void main() {
        vec2 point = gl_PointCoord - 0.5;
        float distanceFromCenter = length(point);
        float softDisc = smoothstep(0.5, 0.08, distanceFromCenter);
        if (softDisc <= 0.01) discard;

        vec3 cloudColor = mix(vec3(0.34, 0.48, 0.42), vec3(0.72, 0.84, 0.72), vDensity);
        float alpha = softDisc * vDensity * vSoftness * 0.14;
        gl_FragColor = vec4(cloudColor, alpha);
        #include <fog_fragment>
      }
    `,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: true,
    transparent: true,
  });

  const clouds = new THREE.Points(geometry, material);
  clouds.name = "walk-mode-clouds";
  clouds.frustumCulled = false;
  clouds.renderOrder = 2;
  clouds.userData.preserveAcrossWalkMode = true;
  cloudLayerCache = { key, layer: clouds };
  return clouds;
}
