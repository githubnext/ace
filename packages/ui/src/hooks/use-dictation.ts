import { useEffect, useRef } from "react";

type Recognition = {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
	onend: (() => void) | null;
	start(): void;
	abort(): void;
};

// WebKit (Safari and the desktop app's WKWebView) and Chromium ship only the prefixed constructor.
const Speech = typeof window === "undefined"
	? undefined
	: (window as unknown as { webkitSpeechRecognition?: new() => Recognition })
		.webkitSpeechRecognition;

/** Whether this runtime can transcribe speech. */
const canDictate = Boolean(Speech);

/**
 * Transcribe the microphone while `active`. `onText` receives the whole session's transcript,
 * interim words included, each time it changes; `onEnd` runs when recognition stops on its own
 * (silence, error, or a denied permission). Deactivating aborts, so the last interim words stand
 * and no late result lands after the caller has moved on.
 */
function useDictation(active: boolean, onText: (text: string) => void, onEnd: () => void) {
	let handlers = useRef({ onText, onEnd });
	handlers.current = { onText, onEnd };

	useEffect(() => {
		if (!active || !Speech) return;
		let recognition = new Speech();
		recognition.continuous = true;
		recognition.interimResults = true;
		recognition.lang = navigator.language;
		recognition.onresult = ({ results }) => {
			let text = "";
			for (let i = 0; i < results.length; i++) text += results[i]![0]!.transcript;
			handlers.current.onText(text);
		};
		recognition.onend = () => handlers.current.onEnd();
		recognition.start();
		return () => {
			recognition.onresult = null;
			recognition.onend = null;
			recognition.abort();
		};
	}, [active]);
}

export { canDictate, useDictation };
