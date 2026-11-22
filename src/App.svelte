<script>
  import { onMount } from 'svelte';
  import * as THREE from 'three';
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
  import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
  import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
  import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

  let canvas;
  let fps = $state(0);

  // live-tunable simulation parameters
  let params = $state({
    speed: 1.0,
    amplitude: 1.0, // scales the sea only; object-made waves keep their own amplitude
    orbWeight: 1.0, // orb mass: shapes its dent/wake and how hard the waves push it
    wireOpacity: 0.85,
    wireOnly: false
  });

  // neon palette
  const NEON = 0xff6a00;

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
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    // cap pixel ratio: bloom hides aliasing, full DPR is wasted fill-rate
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x04030a);

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
    // zoom clamp: the camera stays well inside the mesh (half-width 130)
    controls.maxDistance = 50;
    controls.target.set(0, 0, 0);

    // --- polygonal water mesh: displacement + neon edges live on the GPU ---
    const SIZE = 260;
    const SEGMENTS = 120;
    const MAX_RIPPLES = 20; // fixed GLSL array bound

    // non-indexed: every triangle owns its own vertices -> static barycentric coords
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEGMENTS, SEGMENTS).toNonIndexed();
    geo.rotateX(-Math.PI / 2); // lay it flat: local y becomes world height

    const bary = new Float32Array(geo.attributes.position.count * 3);
    for (let i = 0; i < bary.length; i += 9) {
      bary[i] = 1; // vertex 0 -> (1,0,0)
      bary[i + 4] = 1; // vertex 1 -> (0,1,0)
      bary[i + 8] = 1; // vertex 2 -> (0,0,1)
    }
    geo.setAttribute('aBary', new THREE.BufferAttribute(bary, 3));

    // uniforms shared with the patched shader; updated every tick
    const U = {
      uTime: { value: 0 },
      uAmp: { value: params.amplitude },
      uWireGlow: { value: params.wireOpacity },
      uWireOnly: { value: 0 },
      uFollow: { value: new THREE.Vector4(0, 0, 0, 0) }, // x, z, strength
      uOrb: { value: new THREE.Vector3(0, 14, 1) }, // x, z, weight
      uNeon: { value: new THREE.Color(NEON) },
      uRipCount: { value: 0 },
      uRipA: { value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4()) }, // x, z, t0, amp
      uRipB: { value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4()) } // k, omega, decay, radius
    };

    const waterMat = new THREE.MeshStandardMaterial({
      flatShading: true,
      roughness: 0.35,
      metalness: 0.55,
      emissive: 0xff4a00,
      emissiveIntensity: 0.2
    });

    waterMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, U);

      shader.vertexShader =
        'attribute vec3 aBary;\n' +
        'uniform float uTime;\nuniform float uAmp;\n' +
        'uniform vec4 uFollow;\nuniform vec3 uOrb;\n' +
        'uniform int uRipCount;\nuniform vec4 uRipA[20];\nuniform vec4 uRipB[20];\n' +
        'varying float vWaveH;\nvarying vec3 vBary;\n' +
        shader.vertexShader;

      // mirror of the JS waveHeight() + ripples + floating-body/orb fields
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float base =
          sin(position.x * 0.18 + uTime * 1.25) * 0.9 +
          sin(position.z * 0.21 - uTime * 0.95) * 0.75 +
          sin((position.x + position.z) * 0.12 + uTime * 1.55) * 0.55 +
          sin((position.x - position.z) * 0.27 - uTime * 0.7) * 0.4 +
          sin(position.x * 0.42 + position.z * 0.31 + uTime * 2.1) * 0.3;
        float extra = 0.0;
        for (int i = 0; i < 20; i++) {
          if (i >= uRipCount) break;
          vec4 rp = uRipA[i];
          vec4 q = uRipB[i];
          float age = uTime - rp.z;
          float d = distance(position.xz, rp.xy);
          if (d > q.w) continue;
          extra += rp.w * sin(d * q.x - age * q.y) * exp(-age * q.z) * exp(-d * 0.12);
        }
        if (uFollow.w > 0.02) {
          float s = uFollow.w;
          float d = distance(position.xz, uFollow.xy);
          // heavy dent + bulged rim + persistent ripples from the hovering body
          extra += -2.2 * s * exp(-d * d / 14.0) + 1.0 * s * exp(-(d - 3.2) * (d - 3.2) / 4.0);
          extra += 0.6 * s * sin(d * 0.6 - uTime * 3.4) * exp(-d * 0.15);
        }
        // orb dent scales with its weight (uOrb.z), not with the sea slider
        float m = uOrb.z;
        float od = distance(position.xz, uOrb.xy);
        extra += -0.22 * m * exp(-od * od / 7.0) + 0.12 * m * exp(-(od - 2.0) * (od - 2.0) / 2.5);
        // AMPLITUDE scales the sea; object-made waves keep their own amplitude
        float h = base * uAmp + extra * (0.4 + 0.6 * uAmp);
        transformed.y += h;
        vWaveH = h;
        vBary = aBary;`
      );

      shader.fragmentShader =
        'uniform float uWireGlow;\nuniform float uWireOnly;\nuniform vec3 uNeon;\n' +
        'varying float vWaveH;\nvarying vec3 vBary;\n' +
        shader.fragmentShader;

      // height -> neon gradient (linear-space values)
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float n = clamp((vWaveH + 2.6) / 5.2, 0.0, 1.0);
        vec3 deep = vec3(0.006, 0.002, 0.0);
        vec3 bright = vec3(1.0, 0.102, 0.010);
        vec3 crest = vec3(1.0, 0.631, 0.254);
        diffuseColor.rgb = n > 0.8 ? mix(bright, crest, (n - 0.8) / 0.2) : mix(deep, bright, n);
        if (uWireOnly > 0.5) diffuseColor.rgb = vec3(0.0);`
      );

      // barycentric wireframe: edges = where the smallest barycentric coord is ~0
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float edge = min(min(vBary.x, vBary.y), vBary.z);
        float wire = 1.0 - smoothstep(0.0, fwidth(edge) * 1.5, edge);
        if (uWireOnly > 0.5) totalEmissiveRadiance = uNeon * uWireGlow * wire;
        else totalEmissiveRadiance += uNeon * uWireGlow * wire;`
      );

      // wireframe-only: kill facet lighting (diffuse + specular), keep only the neon edges
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <transmission_fragment>',
        `#include <transmission_fragment>
        if (uWireOnly > 0.5) { totalDiffuse = vec3(0.0); totalSpecular = vec3(0.0); }`
      );
    };

    // one draw call: shaded facets + neon triangle edges together
    const water = new THREE.Mesh(geo, waterMat);
    scene.add(water);

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
    // mip chain at half the usual resolution: bloom is diffuse, the detail is invisible
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth >> 1, window.innerHeight >> 1),
      0.9, // strength
      0.45, // radius
      0.2 // threshold
    );
    composer.addPass(bloom);
    // composer.setSize would reset the bloom to full-res mips; keep it halved
    const baseSetSize = composer.setSize.bind(composer);
    composer.setSize = (w, h) => {
      baseSetSize(w, h);
      bloom.setSize(w >> 1, h >> 1);
    };

    // --- mouse interaction: floating body + splash ripples ---
    let time = 0;
    let splashPulse = 0;

    // expanding ripples: { x, z, t0, amp, k, omega, decay, radius }
    const ripples = [];
    const pointer = { x: 0, z: 0, has: false };
    const follow = { x: 0, z: 0, strength: 0 }; // smoothed "floating object"

    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const waterPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();

    // project the mouse onto the flat water surface (y = 0)
    function pointerWorld(clientX, clientY) {
      ndc.set(
        (clientX / window.innerWidth) * 2 - 1,
        -(clientY / window.innerHeight) * 2 + 1
      );
      raycaster.setFromCamera(ndc, camera);
      return raycaster.ray.intersectPlane(waterPlane, hit) ? hit : null;
    }

    function spawnRipple(x, z, amp, opts = {}) {
      ripples.push({
        x,
        z,
        t0: time,
        amp,
        k: opts.k ?? 0.55, // spatial frequency
        omega: opts.omega ?? 2.4, // temporal frequency
        decay: opts.decay ?? 1.1,
        radius: opts.radius ?? 16
      });
      if (ripples.length > MAX_RIPPLES) ripples.shift();
    }

    let downX = 0, downY = 0, downT = 0;

    function onPointerMove(e) {
      const p = pointerWorld(e.clientX, e.clientY);
      if (!p) {
        pointer.has = false;
        return;
      }
      const step = Math.hypot(p.x - pointer.x, p.z - pointer.z);
      pointer.x = p.x;
      pointer.z = p.z;
      pointer.has = true;
      // wake trail: small ripples while the "body" moves over the water
      if (step > 1.2) {
        spawnRipple(pointer.x, pointer.z, THREE.MathUtils.clamp(step * 0.06, 0.08, 0.5), {
          k: 0.8,
          omega: 3.2,
          decay: 1.8,
          radius: 10
        });
      }
    }

    function onPointerDown(e) {
      downX = e.clientX;
      downY = e.clientY;
      downT = performance.now();
    }

    function onPointerUp(e) {
      // treat as a click (ball thrown in) only if the drag was negligible
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (moved < 6 && performance.now() - downT < 450) {
        const p = pointerWorld(e.clientX, e.clientY);
        if (p) {
          spawnRipple(p.x, p.z, 1.6, { k: 0.5, omega: 2.6, decay: 0.8, radius: 26 });
          splashPulse = 1;
        }
      }
    }

    function onPointerLeave() {
      pointer.has = false;
    }

    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerLeave);

    // neon ring marker = the floating body (heavier/larger)
    const markerGeo = new THREE.RingGeometry(2.4, 3.8, 48);
    markerGeo.rotateX(-Math.PI / 2);
    const markerMat = new THREE.MeshBasicMaterial({
      color: NEON,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const marker = new THREE.Mesh(markerGeo, markerMat);
    marker.visible = false;
    scene.add(marker);

    // --- living neon-blue sphere, WASD-driven, floating over the water ---
    const orbState = { x: 0, z: 14, vx: 0, vz: 0, speed: 0 };
    const orbGeo = new THREE.SphereGeometry(1.6, 32, 24);
    const orbMat = new THREE.MeshStandardMaterial({
      color: 0x00304a,
      emissive: 0x00c8ff,
      emissiveIntensity: 1.6,
      roughness: 0.3,
      metalness: 0.7
    });
    const orb = new THREE.Mesh(orbGeo, orbMat);
    scene.add(orb);
    // neon halo ring around the orb
    const haloGeo = new THREE.RingGeometry(2.2, 2.9, 48);
    haloGeo.rotateX(-Math.PI / 2);
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0x00d8ff,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const halo = new THREE.Mesh(haloGeo, haloMat);
    scene.add(halo);

    const keys = new Set();
    function onKeyDown(e) {
      keys.add(e.key.toLowerCase());
      if (e.key.startsWith('Arrow')) e.preventDefault();
    }
    function onKeyUp(e) {
      keys.delete(e.key.toLowerCase());
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    const camDir = new THREE.Vector3();
    const fwd = new THREE.Vector3();
    const right = new THREE.Vector3();

    function moveOrb(dt) {
      let w = 0, s = 0;
      if (keys.has('w') || keys.has('arrowup')) w += 1;
      if (keys.has('s') || keys.has('arrowdown')) w -= 1;
      if (keys.has('a') || keys.has('arrowleft')) s -= 1;
      if (keys.has('d') || keys.has('arrowright')) s += 1;

      // camera-relative directions projected onto the water plane
      camera.getWorldDirection(camDir);
      fwd.set(camDir.x, 0, camDir.z).normalize();
      right.set(-fwd.z, 0, fwd.x);

      const targetVx = (fwd.x * w + right.x * s) * 22;
      const targetVz = (fwd.z * w + right.z * s) * 22;
      // a heavier orb accelerates slower when steering too
      const m = params.orbWeight;
      const steer = Math.min(dt * 4 / m, 1);
      orbState.vx += (targetVx - orbState.vx) * steer;
      orbState.vz += (targetVz - orbState.vz) * steer;

      // --- water drag: waves push the orb like a current pushing an animal ---
      // wave slope at the orb position (finite differences of the wave field)
      const eps = 1.5;
      const amp = params.amplitude;
      const dhx = (waveHeight(orbState.x + eps, orbState.z, time) -
        waveHeight(orbState.x - eps, orbState.z, time)) * amp / (2 * eps);
      const dhz = (waveHeight(orbState.x, orbState.z + eps, time) -
        waveHeight(orbState.x, orbState.z - eps, time)) * amp / (2 * eps);
      // slides down the wave face: crests ahead slow it, downhill speeds it
      const slopeX = -dhx * 30;
      const slopeZ = -dhz * 30;
      // slow wandering ocean current, so the orb drifts even with no keys
      const curX = Math.sin(orbState.z * 0.06 + time * 0.4) * 1.4;
      const curZ = Math.cos(orbState.x * 0.05 - time * 0.32) * 1.4;

      orbState.vx += (slopeX + curX) * dt * 2.2 / m;
      orbState.vz += (slopeZ + curZ) * dt * 2.2 / m;
      orbState.vx = THREE.MathUtils.clamp(orbState.vx, -30, 30);
      orbState.vz = THREE.MathUtils.clamp(orbState.vz, -30, 30);

      orbState.x = THREE.MathUtils.clamp(orbState.x + orbState.vx * dt, -120, 120);
      orbState.z = THREE.MathUtils.clamp(orbState.z + orbState.vz * dt, -120, 120);
      orbState.speed = Math.hypot(orbState.vx, orbState.vz);

      // wake ripples: amplitude/wavelength come from the orb's own speed + weight,
      // not from the AMPLITUDE slider
      if (orbState.speed > 3) {
        spawnRipple(orbState.x, orbState.z, THREE.MathUtils.clamp(orbState.speed * orbState.speed * 0.004 * m, 0.04, 0.5), {
          k: 0.8 / m, // heavier body -> longer wavelength
          omega: 3.2 / m, // heavier body -> slower ripple
          decay: 1.5,
          radius: 8 + 5 * m
        });
      }
    }

    // --- push the simulation state to the GPU each tick (no per-vertex CPU loop) ---
    function uploadWater(t) {
      U.uTime.value = t;
      U.uAmp.value = params.amplitude;
      U.uWireGlow.value = params.wireOpacity;
      U.uWireOnly.value = params.wireOnly ? 1 : 0;
      U.uFollow.value.set(follow.x, follow.z, follow.strength, 0);
      U.uOrb.value.set(orbState.x, orbState.z, params.orbWeight);
      const n = Math.min(ripples.length, MAX_RIPPLES);
      U.uRipCount.value = n;
      for (let i = 0; i < n; i++) {
        const rp = ripples[i];
        U.uRipA.value[i].set(rp.x, rp.z, rp.t0, rp.amp);
        U.uRipB.value[i].set(rp.k, rp.omega, rp.decay, rp.radius);
      }
    }

    const clock = new THREE.Clock();
    let raf = 0;
    let frames = 0;
    let fpsTimer = 0;

    function tick() {
      const dt = clock.getDelta();
      time += dt * params.speed;

      // heavy body: slower inertia, it lags behind the pointer
      const targetStrength = pointer.has ? 1 : 0;
      follow.strength += (targetStrength - follow.strength) * Math.min(dt * 4.5, 1);
      follow.x += (pointer.x - follow.x) * Math.min(dt * 5.5, 1);
      follow.z += (pointer.z - follow.z) * Math.min(dt * 5.5, 1);

      // prune expired ripples (stored oldest-first)
      while (ripples.length && time - ripples[0].t0 > 6) ripples.shift();

      uploadWater(time);

      // neon marker rides on the dent of the floating body
      marker.visible = follow.strength > 0.02;
      if (marker.visible) {
        const mh = waveHeight(follow.x, follow.z, time) * params.amplitude;
        marker.position.set(follow.x, mh + 0.25, follow.z);
        marker.scale.setScalar(1 + 0.18 * Math.sin(time * 4) + splashPulse * 1.4);
        markerMat.opacity =
          follow.strength * (0.6 + 0.25 * Math.sin(time * 3)) + splashPulse * 0.5;
      }
      splashPulse *= Math.exp(-6 * dt);

      // living orb: rides the waves, pulses with a "breathing" glow
      moveOrb(dt);
      const m = params.orbWeight;
      const oh = waveHeight(orbState.x, orbState.z, time) * params.amplitude;
      // buoyancy: a heavier orb sits lower in its own dent and bobs less
      orb.position.set(orbState.x, oh + 1.35 - 0.3 * m + Math.sin(time * 2.3) * (0.25 / m), orbState.z);
      // heavier orb is physically bigger; the breathing pulse is subtler at mass
      orb.scale.setScalar(0.8 + 0.2 * m + (0.07 / m) * Math.sin(time * 2.6));
      orbMat.emissiveIntensity = 1.5 + 0.6 * Math.sin(time * 1.8);
      halo.position.set(orbState.x, oh + 0.85 - 0.25 * m, orbState.z);
      halo.scale.setScalar(0.8 + 0.2 * m);
      halo.rotation.x = 0.14 * Math.sin(time * 1.5); // gentle tilt sway
      haloMat.opacity = 0.4 + 0.25 * Math.sin(time * 3) + orbState.speed * 0.02;

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
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      controls.dispose();
      geo.dispose();
      waterMat.dispose();
      markerGeo.dispose();
      markerMat.dispose();
      orbGeo.dispose();
      orbMat.dispose();
      haloGeo.dispose();
      haloMat.dispose();
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
    ORB WEIGHT
    <input type="range" bind:value={params.orbWeight} min="0.4" max="2.5" step="0.1" />
    <span>{params.orbWeight.toFixed(1)}</span>
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
  FPS {fps} · drag to orbit · scroll to zoom · hover = floating body · click = splash · WASD = orb (waves drag it · weight shapes its wake)
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
