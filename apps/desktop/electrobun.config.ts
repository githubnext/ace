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
		// Invite links open the app; each channel takes its own scheme so a dev build never answers
		// stable's links.
		urlSchemes: [channel === "stable" ? "ace" : `ace-${channel}`],
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
			// Electrobun writes these usage strings into Info.plist; macOS ends the app when the composer's
			// dictation asks for the microphone or speech recognition without them. Signing uses
			// native/entitlements.plist, which carries the hardened-runtime audio-input entitlement.
			entitlements: {
				"com.apple.security.device.audio-input": "Ace listens while you dictate a message.",
				"com.apple.security.personal-information.speech-recognition":
					"Ace turns your dictation into message text.",
			},
		},
	},
	release: { generatePatch: false },
	runtime: { exitOnLastWindowClosed: false },
	scripts: { postBuild: "scripts/helper.ts", postPackage: "scripts/sign-dev.ts" },
} satisfies ElectrobunConfig;
