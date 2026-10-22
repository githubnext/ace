import { useEffect, useRef } from "react";

type Recognition = {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
	onend: (() => void) | null;
	onerror: ((event: { error: string }) => void) | null;
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

/** Why recognition stopped, for the errors a person can act on; silence ends without one. */
const REASONS: Record<string, string> = {
	"not-allowed": "Microphone access is off for Ace. Allow it in your browser or system settings.",
	"service-not-allowed": "Speech recognition is turned off on this device.",
	"audio-capture": "No microphone was found.",
	network: "Speech recognition needs a network connection.",
	"language-not-supported": "Speech recognition doesn't support this language.",
};

/**
 * Transcribe the microphone while `active`. `onText` receives the whole session's transcript,
 * interim words included, each time it changes; `onEnd` runs when recognition stops on its own
 * (silence, error, or a denied permission), with a reason when a person can act on it. Deactivating aborts, so the last interim words stand
 * and no late result lands after the caller has moved on.
 */
function useDictation(
	active: boolean,
	onText: (text: string) => void,
	onEnd: (reason?: string) => void,
) {
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
		let reason: string | undefined;
		recognition.onerror = ({ error }) => reason = REASONS[error];
		recognition.onend = () => handlers.current.onEnd(reason);
		recognition.start();
		return () => {
			recognition.onresult = null;
			recognition.onend = null;
			recognition.onerror = null;
			recognition.abort();
		};
	}, [active]);
}

export { canDictate, useDictation };
