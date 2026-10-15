import { Toaster as Sonner, type ToasterProps } from "sonner";

import { useResolvedTheme } from "../components/theme";
import { cn } from "../lib/utils";

function Toaster({
	theme,
	position = "bottom-right",
	closeButton = true,
	richColors = false,
	toastOptions,
	className,
	...props
}: ToasterProps) {
	let resolved = useResolvedTheme();
	let classes = toastOptions?.classNames;
	return (
		<Sonner
			theme={theme || resolved}
			position={position}
			closeButton={closeButton}
			richColors={richColors}
			className={cn("ace-toaster", className)}
			toastOptions={{
				...toastOptions,
				classNames: {
					toast: "group toast squircle bg-popover text-popover-foreground shadow-popover",
					title: "text-sm font-medium",
					// Errors from services can be whole pages; the host log keeps the full text.
					description: "line-clamp-6 text-xs break-words text-muted-foreground",
					actionButton: "bg-primary text-primary-foreground squircle text-xs font-medium",
					cancelButton: "bg-secondary text-secondary-foreground squircle text-xs font-medium",
					closeButton: "bg-popover text-popover-foreground shadow-surface",
					...classes,
				},
			}}
			{...props}
		/>
	);
}

export { Toaster };
export type { ToasterProps };
