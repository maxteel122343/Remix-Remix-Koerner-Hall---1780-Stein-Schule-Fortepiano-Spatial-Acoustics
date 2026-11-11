import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs/promises';
import path from 'node:path';

const GSTATIC_BASE = 'https://www.gstatic.com/aistudio/starter-apps/koerner-hall';
const GLB_FILES = [
  'koerner_hall.glb',
  'chair_koerner.glb',
  'stein_1780_fortepiano.glb',
];

function gstaticKoernerGlbPlugin() {
  return {
    name: 'gstatic-koerner-glb-plugin',
    apply: 'build' as const,
    async closeBundle() {
      const outDir = path.resolve(process.cwd(), 'dist', 'gstatic-koerner');
      await fs.mkdir(outDir, { recursive: true });
      await Promise.all(
        GLB_FILES.map(async (file) => {
          const url = `${GSTATIC_BASE}/${file}`;
          const res = await fetch(url);
          if (!res.ok) {
            throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
          }
          const buffer = Buffer.from(await res.arrayBuffer());
          await fs.writeFile(path.join(outDir, file), buffer);
        })
      );
    },
  };
}

const gstaticProxy = {
  '/gstatic-koerner': {
    target: 'https://www.gstatic.com',
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/gstatic-koerner/, '/aistudio/starter-apps/koerner-hall'),
  },
};

export default defineConfig({
  plugins: [react(), gstaticKoernerGlbPlugin()],
  server: {
    port: 3000,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: gstaticProxy,
  },
  preview: {
    port: 3000,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: gstaticProxy,
  },
});
