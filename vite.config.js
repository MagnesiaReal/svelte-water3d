import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  // app is served under https://magneciareal.ddns.net/water/ via Caddy handle_path,
  // so built asset URLs must be prefixed with /water/
  base: '/water/',
  plugins: [svelte()]
});
