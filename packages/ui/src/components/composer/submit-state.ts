import type { SubmitProps } from "./composer-submit";

type StateOptions = Pick<
	SubmitProps,
	"busy" | "busyLabel" | "editing" | "empty" | "plan" | "recording"
>;

export function submitState(
	{
		busy = false,
		busyLabel = "Starting channel",
		editing = false,
		empty = true,
		plan = false,
		recording = false,
	}: StateOptions,
) {
	let mode: "loading" | "stop" | "edit" | "mic" | "plan" | "send" = busy
		? "loading"
		: recording
		? "stop"
		: editing
		? "edit"
		: empty
		? "mic"
		: plan
		? "plan"
		: "send";
	let label = mode === "loading"
		? busyLabel
		: mode === "mic"
		? "Record"
		: mode === "stop"
		? "Stop"
		: mode === "edit"
		? "Save edit"
		: "Send";

	return { disabled: mode === "loading", label, mode };
}
