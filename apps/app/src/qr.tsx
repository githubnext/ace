import { useMemo } from "react";
import { encode } from "uqr";

/**
 * Dark modules on a white quiet zone in both themes: phone cameras often fail to read an inverted
 * code.
 */
export function Qr(
	{ value, label, className }: { value: string; label: string; className?: string },
) {
	const { size, path } = useMemo(() => {
		const { size, data } = encode(value, { border: 2 });
		const path = data.flatMap((row, y) =>
			row.flatMap((dark, x) => dark ? [`M${x} ${y}h1v1h-1z`] : [])
		);
		return { size, path: path.join("") };
	}, [value]);

	return (
		<svg
			role="img"
			aria-label={label}
			viewBox={`0 0 ${size} ${size}`}
			shapeRendering="crispEdges"
			className={className}
		>
			<rect width={size} height={size} fill="#fff" />
			<path d={path} fill="#000" />
		</svg>
	);
}
