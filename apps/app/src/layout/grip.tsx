import type { KeyboardEvent, PointerEvent } from "react";

import * as Split from "@ace/split-tabs";

type Props = {
	handle: Split.Handle;
	frozen: boolean;
	onStart: (event: PointerEvent<HTMLElement>, handle: Split.Handle) => void;
	onKey: (event: KeyboardEvent<HTMLElement>, handle: Split.Handle) => void;
};

export function Grip({ handle, frozen, onStart, onKey }: Props) {
	return (
		<div
			role="separator"
			tabIndex={0}
			aria-label={handle.axis === "col" ? "Resize columns" : "Resize rows"}
			aria-orientation={handle.axis === "col" ? "vertical" : "horizontal"}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.round(handle.ratio * 100)}
			data-axis={handle.axis}
			className={`layout-grip z-30 touch-none rounded-full bg-transparent outline-none contain-strict ${
				frozen ? "pointer-events-none" : ""
			} ${
				handle.axis === "col"
					? "w-3 -translate-x-1/2 cursor-col-resize"
					: "h-3 -translate-y-1/2 cursor-row-resize"
			}`}
			style={{ gridArea: Split.place(handle) }}
			onPointerDown={(event) => onStart(event, handle)}
			onKeyDown={(event) => onKey(event, handle)}
		/>
	);
}
