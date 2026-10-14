import type { FileDiffMetadata } from "@pierre/diffs";

import type { Block } from "../../lib/block";
import { Diff } from "../diff/diff";
import { patchFile } from "../../lib/highlighter";
import { code } from "./code";

const LINE_HEIGHT = 20;
const SEPARATOR_HEIGHT = 32;
const PADDING_TOP = 8;
const PADDING_BOTTOM = 2;
const BORDER_Y = 2;

/** Unified-diff block rendering a single-file patch via @pierre/diffs. Any
 *  other text is shown as diff-highlighted code so nothing is dropped. */
function diff(
	patch: string,
	streaming = false,
	parsed: FileDiffMetadata | null = patchFile(patch),
): Block {
	if (!parsed && !streaming) return code(patch, "diff");
	let lines = Math.max(1, patch.split("\n").length);
	let separators = 0;
	if (parsed) {
		lines = 0;
		for (let hunk of parsed.hunks) {
			lines += hunk.unifiedLineCount;
			if (hunk.collapsedBefore > 0) separators++;
			if (hunk.noEOFCRAdditions || hunk.noEOFCRDeletions) lines++;
		}
		lines = Math.max(1, lines);
	}

	let height = PADDING_TOP + PADDING_BOTTOM + BORDER_Y + lines * LINE_HEIGHT
		+ separators * SEPARATOR_HEIGHT;
	let block: Block & { streaming: boolean } = {
		streaming,

		measure(width) {
			return { height, fit: width };
		},
		render() {
			// A streamed block can settle in place before its reparse lands; without a
			// parsed file it stays raw text, which is what its height was measured for.
			return (
				<Diff
					patch={patch}
					streaming={block.streaming || !parsed}
					height={height}
					file={parsed}
					hunkSeparators="metadata"
				/>
			);
		},
	};

	return block;
}

export { diff };
