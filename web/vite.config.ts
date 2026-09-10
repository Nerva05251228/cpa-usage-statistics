import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({ plugins: [react(), viteSingleFile()], resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } }, build: { target: 'es2022', sourcemap: false } });
