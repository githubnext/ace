import { relative } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const host = `http://127.0.0.1:${process.env.ACE_PORT || 4140}`;

// Desktop builds credit the packages this bundle actually contains (apps/desktop/scripts/notices.ts).
const modules: Plugin = {
	name: "ace-modules",
	apply: "build",
	generateBundle(_, bundle) {
		const ids = Object.values(bundle).flatMap((output) =>
			output.type === "chunk" ? Object.keys(output.modules) : output.originalFileNames
		);
		// Rollup marks virtual and transformed modules with a \0 prefix or a query.
		const paths = ids.map((id) => (id.startsWith("\0") ? id.slice(1) : id).split("?")[0]!);
		const files = [...new Set(paths.filter((path) => path.includes("/node_modules/")))];
		this.emitFile({
			type: "asset",
			fileName: ".vite/modules.json",
			source: JSON.stringify(files.map((file) => relative(import.meta.dirname, file)).sort()),
		});
	},
};

export default defineConfig({
	plugins: [react(), tailwindcss(), modules],
	server: {
		host: "127.0.0.1",
		port: 1111,
		proxy: { "/ws": { target: host, ws: true, changeOrigin: true } },
	},
});
