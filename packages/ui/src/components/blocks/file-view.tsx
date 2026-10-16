import { useState } from "react";

import { cn } from "../../lib/utils";
import { Dialog, DialogContent, DialogTitle } from "../../ui/dialog";
import { FileView as Contents } from "../file/file-view";
import { FILE_HEIGHT } from "./constants";

function FileView({ name, text }: { name: string; text?: string }) {
	let [open, setOpen] = useState(false);
	let lines = text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
	let card = (
		<>
			<div className="shrink-0 text-lg">📄</div>
			<div className="flex min-w-0 flex-col">
				<span className="truncate text-sm text-foreground">{name}</span>
				<span className="truncate text-xs text-muted-foreground">
					{text === undefined ? "" : `${lines.toLocaleString()} ${lines === 1 ? "line" : "lines"}`}
				</span>
			</div>
		</>
	);
	let className =
		"flex w-full min-w-0 items-center gap-3 overflow-hidden rounded-lg squircle border border-border px-3 text-left contain-strict";
	if (text === undefined) {
		return <div className={className} style={{ blockSize: FILE_HEIGHT }}>{card}</div>;
	}
	return (
		<>
			<button
				type="button"
				aria-label={`Open ${name}`}
				className={cn(className, "cursor-pointer hover:bg-muted/50")}
				style={{ blockSize: FILE_HEIGHT }}
				onClick={() => setOpen(true)}
			>
				{card}
			</button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="top-4 h-(--dialog-max) max-w-[calc(100vw-2rem)] gap-0 overflow-hidden p-0 [--dialog-top:1rem] sm:max-w-4xl">
					<DialogTitle className="sr-only">{name}</DialogTitle>
					<Contents path={name} source={text} className="[&>header]:pr-10" />
				</DialogContent>
			</Dialog>
		</>
	);
}

export { FileView };
