import type { Context } from "@earendil-works/chord";
import { defineExtension, type Extension, wrapTool } from "@earendil-works/pi-durable";
import { type ExecutionEnv, getOrThrow } from "@earendil-works/pi-durable/env";
import { createReadTool } from "@earendil-works/pi-durable/tools";

/** `text` describes the image for the model; `image` is already bounded for a pi row. */
export type ImageFile = { text: string; image: { mimeType: string; data: string } };
/** Reads and bounds an image at an absolute path on the execution host. */
export type Images = (path: string, context: Context) => Promise<ImageFile>;

const NARROW_NO_BREAK_SPACE = " ";

/** Pi's read sniffs image bytes and refuses them; the execution host decodes and bounds them instead. */
export function images(read: Images): Extension {
	return defineExtension({
		name: "ace-images",
		wraps: [
			wrapTool(createReadTool(), (tool) => ({
				...tool,
				description:
					`${tool.description} PNG, JPEG, GIF, WebP, and BMP files are returned as an image you can see, downscaled to fit the result limit.`,
				async execute(args, api, context) {
					const result = await tool.execute(args, api, context);
					if (!result.diagnostics?.some(({ code }) => code === "unsupported_image")) return result;
					const { text, image } = await read(await resolve(api.env!, args.path, context), context);
					return { content: [{ type: "text", text }, { type: "image", ...image }] };
				},
			})),
		],
	});
}

/** Mirrors pi's read path resolution, including macOS screenshot names, so both read the same file. */
async function resolve(env: ExecutionEnv, path: string, context: Context): Promise<string> {
	const normalized = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	const resolved = getOrThrow(
		await env.absolutePath(normalized.startsWith("@") ? normalized.slice(1) : normalized, context),
	);
	const variants = new Set([
		resolved,
		resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
		resolved.normalize("NFD"),
		resolved.replace(/'/g, "’"),
		resolved.normalize("NFD").replace(/'/g, "’"),
	]);
	for (const variant of variants) {
		if (getOrThrow(await env.exists(variant, context))) return variant;
	}
	return resolved;
}
