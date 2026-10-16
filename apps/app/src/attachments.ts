import type { PDFPageProxy } from "pdfjs-dist";

import type { Image, TextFile } from "@ace/channel/protocol";
import type { Attachment } from "@ace/ui";

/** Matches the channel's per-message limit, with room for the message's text. */
const BUDGET = 1_400_000;
const EDGE = 2000;

type TextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;

async function encode(url: string, edge: number, quality: number): Promise<Image> {
	const bitmap = await createImageBitmap(await (await fetch(url)).blob());
	const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
	const canvas = new OffscreenCanvas(
		Math.round(bitmap.width * scale),
		Math.round(bitmap.height * scale),
	);
	canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	bitmap.close();
	const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return { mimeType: "image/jpeg", data: btoa(binary) };
}

/** Reads the stream itself: getTextContent iterates it, and WebKit's streams aren't iterable. */
async function text(page: PDFPageProxy): Promise<string> {
	const reader: ReadableStreamDefaultReader<TextContent> = page.streamTextContent().getReader();
	let lines = "";
	for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
		for (const item of chunk.value.items) {
			if ("str" in item) lines += item.str + (item.hasEOL ? "\n" : "");
		}
	}
	return lines;
}

/**
 * Providers' document inputs aren't in pi's message format, so a PDF goes to models as its pages'
 * text, like any text file. Scanned pages have no text and can't be read this way.
 */
async function pdf(file: File): Promise<TextFile> {
	const [{ getDocument, GlobalWorkerOptions }, worker] = await Promise.all([
		import("pdfjs-dist"),
		import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
	]);
	GlobalWorkerOptions.workerSrc = worker.default;
	const task = getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
	try {
		const doc = await task.promise.catch(() => {
			throw new Error(`${file.name} couldn't be read as a PDF`);
		});
		const pages: string[] = [];
		for (let number = 1; number <= doc.numPages; number++) {
			pages.push(await text(await doc.getPage(number)));
		}
		const joined = pages.join("\n\n").trim();
		if (!joined) {
			throw new Error(`${file.name} has no text to read; scanned PDFs can't be attached`);
		}
		return { name: file.name, text: joined };
	} finally {
		await task.destroy();
	}
}

/** Models read files as text, so only valid UTF-8 without NUL bytes can be sent. */
async function read(file: File): Promise<TextFile> {
	// A withdrawn PDF returns to the composer as its text, typed text/plain.
	if (file.type === "application/pdf") return pdf(file);
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const text = await file.arrayBuffer().then((bytes) => decoder.decode(bytes)).catch(() => "\0");
	if (text.includes("\0")) {
		throw new Error(
			`${file.name} isn't a text file; only images, text files, and PDFs can be attached`,
		);
	}
	return { name: file.name, text };
}

/**
 * Read attached text files and PDFs, then re-encode attached images as JPEG, shrinking until the message
 * fits the channel's limit. Re-encoding also strips metadata such as location from photos.
 */
export async function attachments(
	attached: Attachment[],
): Promise<{ images?: Image[]; files?: TextFile[] }> {
	const sources: Attachment[] = [];
	const reads: Promise<TextFile>[] = [];
	for (const item of attached) {
		if (item.type.startsWith("image/") && item.preview) sources.push(item);
		else reads.push(read(item.file!));
	}
	const files = await Promise.all(reads);
	const encoder = new TextEncoder();
	const budget = files.reduce((left, file) => left - encoder.encode(file.text).length, BUDGET);
	if (budget < 0) throw new Error("These files are too large to send together");
	const found = files.length ? { files } : {};
	if (!sources.length) return found;
	for (let edge = EDGE, quality = 0.9; edge >= 400; edge = Math.round(edge * 0.75), quality = 0.8) {
		const images = await Promise.all(sources.map((item) => encode(item.preview!, edge, quality)));
		if (images.reduce((size, image) => size + image.data.length, 0) <= budget) {
			return { ...found, images };
		}
	}
	throw new Error(
		files.length
			? "These images and files are too large to send together"
			: "These images are too large to send together",
	);
}
