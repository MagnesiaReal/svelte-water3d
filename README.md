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
- HUD panel: wave speed, amplitude, wire glow opacity, wireframe-only toggle.

## How it works

- `PlaneGeometry` (90×90 segments) triangulated into ~16k triangles.
- Each frame, vertex heights are displaced by layered sine waves (procedural water).
- Vertex colors map wave height → dark amber to bright neon orange.
- A wireframe overlay in `#ff6a00` + `UnrealBloomPass` produces the neon glow.
- `MeshStandardMaterial` with `flatShading` keeps the faceted, polygonal look.
