# svelte-water3D

Cyberpunk-style 3D water simulation: a polygonal triangle mesh with orange neon edges, flat-shaded faceted fill, animated wave motion, and bloom glow — built with Svelte 5 + Three.js + Vite.

## Run

```bash
npm install
npm run dev
```

Open the URL Vite prints (http://localhost:5173).

## Build

```bash
npm run build
npm run preview
```

## Controls

- **Drag** to orbit, **scroll** to zoom (camera auto-rotates).
- **Hover** = heavy floating body (dent + persistent ripples), **click** = splash.
- **WASD / arrows** = living neon-blue orb; waves add/subtract from its velocity.
- HUD panel: wave speed, amplitude, orb weight, wire glow opacity, wireframe-only toggle.

## How it works

- `PlaneGeometry` (260 units, 120×120 segments) triangulated into ~28k triangles, with a zoom clamp so the camera stays inside the mesh.
- Vertex heights are displaced in the **vertex shader** (5 layered sine waves + up to 20 ripple rings + gaussian dent fields, fed as uniforms) — no per-vertex CPU loop or buffer uploads.
- `AMPLITUDE` scales only the sea's own sine layers; waves made by objects (pointer dent, orb dent, wake ripples) keep their own amplitude (`extra * (0.4 + 0.6 * uAmp)`), so the slider never erases them. The orb's dent and wake scale with `ORB WEIGHT` instead, and its mass also divides the wave forces that push it.
- Colors map wave height → dark amber to bright neon orange in the fragment shader.
- Triangle edges are drawn with **barycentric coordinates** (static `aBary` attribute + `fwidth`), so fill + neon wireframe render in one draw call.
- `MeshStandardMaterial` with `flatShading` keeps the faceted, polygonal look; `UnrealBloomPass` runs at half resolution for the glow.
