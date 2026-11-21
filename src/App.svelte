<script>
  import { onMount } from 'svelte';
  import * as THREE from 'three';
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
  import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
  import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
  import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

  let canvas;
  let fps = 0;

  // live-tunable simulation parameters
  let params = $state({
    speed: 1.0,
    amplitude: 1.0,
    wireOpacity: 0.85,
    wireOnly: false
  });

  // neon palette
  const NEON = 0xff6a00;
  const DEEP = new THREE.Color(0x120600);
  const MID = new THREE.Color(0x5a1c00);
  const BRIGHT = new THREE.Color(0xff8a2a);
  const CREST = new THREE.Color(0xffd08a);

  // layered sine waves ≈ procedural water surface
  function waveHeight(x, z, t) {
    return (
      Math.sin(x * 0.18 + t * 1.25) * 0.9 +
      Math.sin(z * 0.21 - t * 0.95) * 0.75 +
      Math.sin((x + z) * 0.12 + t * 1.55) * 0.55 +
      Math.sin((x - z) * 0.27 - t * 0.7) * 0.4 +
      Math.sin(x * 0.42 + z * 0.31 + t * 2.1) * 0.3
    );
  }

  onMount(() => {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x04030a);
    scene.fog = new THREE.Fog(0x04030a, 45, 160);

    const camera = new THREE.PerspectiveCamera(
      55,
      window.innerWidth / window.innerHeight,
      0.1,
      300
    );
    camera.position.set(0, 18, 36);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.5;
    controls.maxPolarAngle = Math.PI * 0.46;
    controls.minDistance = 8;
    controls.maxDistance = 120;
    controls.target.set(0, 0, 0);

    // --- polygonal water mesh ---
    const SIZE = 130;
    const SEGMENTS = 90;
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEGMENTS, SEGMENTS);
    geo.rotateX(-Math.PI / 2); // lay it flat: local y becomes world height

    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    // faceted fill: flat-shaded triangles tinted by wave height
    const fillMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.35,
      metalness: 0.55,
      emissive: 0xff4a00,
      emissiveIntensity: 0.2
    });
    const fill = new THREE.Mesh(geo, fillMat);

    // neon triangle wireframe
    const wireMat = new THREE.MeshBasicMaterial({
      color: NEON,
      wireframe: true,
      transparent: true,
      opacity: params.wireOpacity
    });
    const wire = new THREE.Mesh(geo, wireMat);

    scene.add(fill, wire);

    // lights
    scene.add(new THREE.AmbientLight(0x2a1408, 0.9));
    const key = new THREE.DirectionalLight(0xff9050, 1.4);
    key.position.set(12, 24, 8);
    scene.add(key);
    const rim = new THREE.PointLight(0xff3050, 0.8, 120);
    rim.position.set(-40, 8, -40);
    scene.add(rim);

    // --- bloom for the neon glow ---
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.9, // strength
      0.45, // radius
      0.2 // threshold
    );
    composer.addPass(bloom);

    // --- animate the mesh ---
    const tmp = new THREE.Color();
    function updateWater(t) {
      const arr = pos.array;
      const col = colors;
      for (let i = 0; i < pos.count; i++) {
        const x = arr[i * 3];
        const z = arr[i * 3 + 2];
        const h = waveHeight(x, z, t) * params.amplitude;
        arr[i * 3 + 1] = h;

        // height -> neon gradient
        const n = THREE.MathUtils.clamp((h + 2.6) / 5.2, 0, 1);
        if (n > 0.8) {
          tmp.copy(BRIGHT).lerp(CREST, (n - 0.8) / 0.2);
        } else {
          tmp.copy(DEEP).lerp(BRIGHT, n);
        }
        col[i * 3] = tmp.r;
        col[i * 3 + 1] = tmp.g;
        col[i * 3 + 2] = tmp.b;
      }
      pos.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
    }

    const clock = new THREE.Clock();
    let time = 0;
    let raf = 0;
    let frames = 0;
    let fpsTimer = 0;

    function tick() {
      const dt = clock.getDelta();
      time += dt * params.speed;

      updateWater(time);
      wireMat.opacity = params.wireOpacity;
      fill.visible = !params.wireOnly;

      controls.update();
      composer.render();

      frames++;
      fpsTimer += dt;
      if (fpsTimer >= 0.5) {
        fps = Math.round(frames / fpsTimer);
        frames = 0;
        fpsTimer = 0;
      }
      raf = requestAnimationFrame(tick);
    }
    tick();

    function onResize() {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      composer.setSize(window.innerWidth, window.innerHeight);
    }
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      controls.dispose();
      geo.dispose();
      fillMat.dispose();
      wireMat.dispose();
      composer.dispose();
      renderer.dispose();
    };
  });
</script>

<canvas bind:this={canvas}></canvas>

<div class="hud">
  <h1>WATER<span class="slash">//</span>3D</h1>
  <p class="sub">polygonal neon mesh · cyberpunk sim</p>
</div>

<div class="panel">
  <label>
    SPEED
    <input type="range" bind:value={params.speed} min="0" max="2.5" step="0.05" />
    <span>{params.speed.toFixed(2)}</span>
  </label>
  <label>
    AMPLITUDE
    <input type="range" bind:value={params.amplitude} min="0.1" max="2.2" step="0.05" />
    <span>{params.amplitude.toFixed(2)}</span>
  </label>
  <label>
    WIRE GLOW
    <input type="range" bind:value={params.wireOpacity} min="0.05" max="1" step="0.05" />
    <span>{params.wireOpacity.toFixed(2)}</span>
  </label>
  <label class="chk">
    <input type="checkbox" bind:checked={params.wireOnly} />
    WIREFRAME ONLY
  </label>
</div>

<div class="telemetry">
  FPS {fps} · drag to orbit · scroll to zoom
</div>

<style>
  canvas {
    display: block;
    width: 100vw;
    height: 100vh;
  }

  .hud {
    position: fixed;
    top: 22px;
    left: 24px;
    pointer-events: none;
    font-family: 'Courier New', monospace;
  }
  .hud h1 {
    margin: 0;
    font-size: 26px;
    letter-spacing: 6px;
    color: #ff6a00;
    text-shadow: 0 0 8px #ff6a00, 0 0 22px rgba(255, 106, 0, 0.6);
  }
  .hud .slash {
    color: #ff3050;
  }
  .hud .sub {
    margin: 4px 0 0;
    font-size: 11px;
    letter-spacing: 3px;
    color: rgba(255, 138, 42, 0.7);
  }

  .panel {
    position: fixed;
    bottom: 22px;
    left: 24px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px 16px;
    border: 1px solid rgba(255, 106, 0, 0.5);
    background: rgba(8, 4, 12, 0.72);
    backdrop-filter: blur(4px);
    font-family: 'Courier New', monospace;
    font-size: 11px;
    letter-spacing: 2px;
    color: #ffb066;
    clip-path: polygon(0 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%);
  }
  .panel label {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .panel span {
    min-width: 42px;
    color: #ff6a00;
    text-align: right;
  }
  .panel input[type='range'] {
    width: 120px;
    accent-color: #ff6a00;
  }
  .panel input[type='checkbox'] {
    accent-color: #ff6a00;
  }

  .telemetry {
    position: fixed;
    bottom: 22px;
    right: 24px;
    font-family: 'Courier New', monospace;
    font-size: 11px;
    letter-spacing: 2px;
    color: rgba(255, 138, 42, 0.65);
    pointer-events: none;
  }

  /* cyberpunk scanlines overlay */
  .hud, .panel, .telemetry {
    z-index: 2;
  }
  .scanlines {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 1;
    background: repeating-linear-gradient(
      to bottom,
      transparent 0px,
      transparent 2px,
      rgba(255, 106, 0, 0.04) 3px
    );
  }
</style>

<!-- scanline overlay -->
<div class="scanlines"></div>
