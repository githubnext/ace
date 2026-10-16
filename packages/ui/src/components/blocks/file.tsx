import type { Block } from "../../lib/block";

import { FileView } from "./file-view";
import { FILE_HEIGHT } from "./constants";

/** File attachment block with fixed height; one carrying its contents opens them. */
function file(name: string, text?: string): Block {
	return {
		measure(width) {
			return { height: FILE_HEIGHT, fit: width };
		},
		render() {
			return <FileView name={name} text={text} />;
		},
	};
}

export { file };
