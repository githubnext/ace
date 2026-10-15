import { stat } from "node:fs/promises";

import type { Images } from "@ace/channel/images";

// Matches desktop_inspect screenshots: one result must fit the hosted channel's 2 MB SQLite row.
const MAX_IMAGE = 900_000;
const MAX_FILE = 32_000_000;
const EDGES = [1600, 1200, 800];
/** Formats every model provider accepts as-is; others are re-encoded. */
const PASSTHROUGH = new Set(["png", "jpeg", "webp", "gif"]);

const megabytes = (size: number) => `${(size / 1_000_000).toFixed(1)} MB`;

export const images: Images = async (path) => {
	const { size } = await stat(path);
	if (size > MAX_FILE) {
		throw new Error(
			`${path} is ${megabytes(size)}; images over ${megabytes(MAX_FILE)} can't be read.`,
		);
	}
	const bytes = await Bun.file(path).bytes();
	const { width, height, format } = await new Bun.Image(bytes).metadata();
	const original = `${format} image, ${width}x${height}`;
	if (PASSTHROUGH.has(format) && size <= MAX_IMAGE && Math.max(width, height) <= EDGES[0]!) {
		return {
			text: `Read ${original}.`,
			image: { mimeType: `image/${format}`, data: Buffer.from(bytes).toString("base64") },
		};
	}
	for (const edge of EDGES) {
		const image = new Bun.Image(bytes)
			.resize(edge, edge, { fit: "inside", withoutEnlargement: true })
			.webp({ quality: 80 });
		const encoded = await image.bytes();
		if (encoded.length > MAX_IMAGE) continue;
		return {
			text: `Read ${original}, shown downscaled to ${image.width}x${image.height}.`,
			image: { mimeType: "image/webp", data: Buffer.from(encoded).toString("base64") },
		};
	}
	throw new Error(
		`${path} could not be downscaled within the ${megabytes(MAX_IMAGE)} result limit.`,
	);
};
