type DiffViewFile = {
	file: string;
	from?: string;
	binary?: boolean;
	patch?: string;
	oldFile?: { name: string; contents: string };
	newFile?: { name: string; contents: string };
	signature?: string;
	adds: number;
	dels: number;
	pending?: boolean;
	error?: string;
	/** Files sharing a group are totaled together, apart from other groups. */
	group?: string;
	/** Shown instead of line counts for an entry without a diff, such as a summarized directory. */
	note?: string;
};

type DiffViewMode = "unified" | "split";

type DiffViewPr = {
	state: "open" | "draft" | "closed" | "merged";
	number: string;
	url?: string;
	title?: string;
};

type DiffViewProps = {
	files: DiffViewFile[];
	base?: string;
	head?: string;
	pr?: DiffViewPr;
	creatingPr?: boolean;
	preparingPr?: boolean;
	mode?: DiffViewMode;
	defaultMode?: DiffViewMode;
	defaultFileTreeOpen?: boolean;
	selected?: string;
	selectedKey?: string | number;
	onSelectedChange?: (file: string) => void;
	onModeChange?: (mode: DiffViewMode) => void;
	onOpenPr?: () => void;
	onCreatePr?: () => void;
	onCreateDraftPr?: () => void;
	onManualCreatePr?: () => void;
	onFileOpen?: (file: DiffViewFile) => void;
	className?: string;
};

export type { DiffViewFile, DiffViewMode, DiffViewPr, DiffViewProps };
