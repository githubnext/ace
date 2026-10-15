import type { ElectrobunConfig } from "electrobun";

import { current } from "./scripts/version";

const channel = process.env.ACE_BUILD_CHANNEL || "dev";

export default {
	app: {
		name: "Ace",
		identifier: channel === "stable" ? "dev.ace.desktop" : `dev.ace.desktop.${channel}`,
		// Electrobun writes this to CFBundleVersion and version.json; the helper script moves it to
		// CFBundleShortVersionString and sets the orderable bundle version.
		version: current(channel).display,
	},
	build: {
		// Electrobun's bundled runtime matches its native FFI; Ace Helper carries its own Bun.
		bun: { entrypoint: "src/index.ts" },
		copy: {
			"../app/dist": "web",
		},
		buildFolder: "dist",
		artifactFolder: "artifacts",
		// Release packaging signs the real app; Electrobun's self-extracting wrapper is unused.
		mac: {
			icons: channel === "canary" ? "icons/canary.iconset" : "icons/ace.iconset",
			codesign: false,
			notarize: false,
			createDmg: false,
		},
	},
	release: { generatePatch: false },
	runtime: { exitOnLastWindowClosed: false },
	scripts: { postBuild: "scripts/helper.ts", postPackage: "scripts/sign-dev.ts" },
} satisfies ElectrobunConfig;
