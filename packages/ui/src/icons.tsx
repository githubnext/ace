import {
	Archive,
	ArchiveRestore,
	ArrowDownToLine,
	ArrowUp,
	ArrowUpRight,
	Baseline,
	Bold,
	Bot,
	Braces,
	Brain,
	Check,
	ChevronDown,
	ChevronRight,
	CircleCheck,
	CircleDashed,
	CircleDot,
	CircleX,
	Cloud,
	Code,
	Columns2,
	Command,
	Copy,
	Database,
	Ellipsis,
	ExternalLink,
	Eye,
	FaceGrinning,
	FaceSlightlySmilingPlus,
	File,
	FileArchive,
	FileDiff,
	FileSearch,
	FileText,
	Film,
	FolderSearch,
	FolderTree,
	FoldVertical,
	GitBranch,
	GitCommitHorizontal,
	GitFork,
	GitMerge,
	GitPullRequest,
	GitPullRequestClosed,
	Globe,
	Hand,
	Hash,
	House,
	Image,
	Info,
	Italic,
	KeyRound,
	Laptop,
	Link,
	List,
	ListChecks,
	ListOrdered,
	ListTodo,
	ListTree,
	Loader,
	Lock,
	LogIn,
	LogOut,
	type LucideIcon,
	type LucideProps,
	Maximize2,
	MessageCircle,
	MessageSquareShare,
	Mic,
	Monitor,
	MousePointer2,
	Music,
	PaintBucket,
	PanelLeft,
	Paperclip,
	Pencil,
	Pin,
	PinOff,
	Play,
	Plus,
	RotateCw,
	Rows2,
	Search,
	Send,
	Server,
	Settings2,
	Sparkles,
	Square,
	SquareCode,
	SquareTerminal,
	Strikethrough,
	Terminal,
	TextQuote,
	Trash,
	Underline,
	UnfoldVertical,
	Wrench,
	X,
	Zap,
} from "lucide-react";
import {
	Clock as ClockSvg,
	FaceSlightlySmiling as FaceSvg,
	Flag as FlagSvg,
	Globe as GlobeSvg,
	Hamburger as HamburgerSvg,
	Hash as HashSvg,
	Leaf as LeafSvg,
	Lightbulb as LightbulbSvg,
	Volleyball as VolleyballSvg,
} from "lucide-static";

// Every icon the package renders is imported here so the icon pack can be swapped in one file.

export type IconProps = LucideProps;

// The UI was laid out against an 18px outline set with a 1.5/18 stroke; Lucide's 2/24 keeps that ratio.
function outline(Icon: LucideIcon) {
	return (props: IconProps) => <Icon size={18} {...props} />;
}

// Compact glyphs (composer, timeline disclosure) were a heavier 20px set with a 2/20 stroke.
function micro(Icon: LucideIcon) {
	return (props: IconProps) => <Icon size={20} strokeWidth={2.4} {...props} />;
}

export const IconArchive = outline(Archive);
export const IconArchiveRestore = outline(ArchiveRestore);
export const IconArrowDownToLine = outline(ArrowDownToLine);
export const IconArrowUpRight = outline(ArrowUpRight);
export const IconBolt = outline(Zap);
export const IconBot = outline(Bot);
export const IconBranch = outline(GitBranch);
export const IconBraces = outline(Braces);
export const IconBrain = outline(Brain);
export const IconCheck = outline(Check);
export const IconChecklist = outline(ListChecks);
export const IconChevronDown = outline(ChevronDown);
export const IconChevronRight = outline(ChevronRight);
export const IconCircleCheck = outline(CircleCheck);
export const IconCircleDashed = outline(CircleDashed);
export const IconCircleX = outline(CircleX);
export const IconCloud = outline(Cloud);
export const IconCode = outline(Code);
export const IconCollapseVertical = outline(FoldVertical);
export const IconCommand = outline(Command);
export const IconCommit = outline(GitCommitHorizontal);
export const IconConsole = outline(SquareTerminal);
export const IconCopy = outline(Copy);
export const IconDatabase = outline(Database);
export const IconDots = outline(Ellipsis);
export const IconEnter = outline(LogIn);
export const IconExit = outline(LogOut);
export const IconExpand = outline(Maximize2);
export const IconExpandVertical = outline(UnfoldVertical);
export const IconExternal = outline(ExternalLink);
export const IconEye = outline(Eye);
export const IconFile = outline(File);
export const IconFileArchive = outline(FileArchive);
export const IconFileDiff = outline(FileDiff);
export const IconFileSearch = outline(FileSearch);
export const IconFileText = outline(FileText);
export const IconFileTree = outline(FolderTree);
export const IconFilm = outline(Film);
export const IconFolderSearch = outline(FolderSearch);
export const IconFork = outline(GitFork);
export const IconGlobe = outline(Globe);
export const IconHand = outline(Hand);
export const IconHash = outline(Hash);
export const IconHome = outline(House);
export const IconImage = outline(Image);
export const IconInfo = outline(Info);
export const IconIssue = outline(CircleDot);
export const IconKey = outline(KeyRound);
export const IconLaptop = outline(Laptop);
export const IconListTree = outline(ListTree);
export const IconLoader = outline(Loader);
export const IconLock = outline(Lock);
export const IconMerge = outline(GitMerge);
export const IconMessage = outline(MessageCircle);
export const IconMessageForward = outline(MessageSquareShare);
export const IconMonitor = outline(Monitor);
export const IconMusic = outline(Music);
export const IconPaintBucket = outline(PaintBucket);
export const IconPencil = outline(Pencil);
export const IconPin = outline(Pin);
export const IconPinOff = outline(PinOff);
export const IconPlay = outline(Play);
export const IconPlus = outline(Plus);
export const IconPointer = outline(MousePointer2);
export const IconPullRequest = outline(GitPullRequest);
export const IconPullRequestClosed = outline(GitPullRequestClosed);
export const IconReact = outline(FaceSlightlySmilingPlus);
export const IconRecord = outline(CircleDot);
export const IconRotate = outline(RotateCw);
export const IconRows = outline(Rows2);
export const IconSearch = outline(Search);
export const IconServer = outline(Server);
export const IconSettings = outline(Settings2);
export const IconSidebar = outline(PanelLeft);
export const IconSplitView = outline(Columns2);
export const IconStop = outline(Square);
export const IconTasks = outline(ListTodo);
export const IconTerminal = outline(Terminal);
export const IconTrash = outline(Trash);
export const IconWrench = outline(Wrench);
export const IconX = outline(X);

export const IconArrowDownToLineMicro = micro(ArrowDownToLine);
export const IconArrowUpMicro = micro(ArrowUp);
export const IconAttachMicro = micro(Paperclip);
export const IconBoldMicro = micro(Bold);
export const IconBulletListMicro = micro(List);
export const IconCheckMicro = micro(Check);
export const IconChevronDownMicro = micro(ChevronDown);
export const IconChevronRightMicro = micro(ChevronRight);
export const IconCodeBlockMicro = micro(SquareCode);
export const IconCodeMicro = micro(Code);
export const IconConsoleMicro = micro(SquareTerminal);
export const IconEmojiMicro = micro(FaceGrinning);
export const IconItalicMicro = micro(Italic);
export const IconLinkMicro = micro(Link);
export const IconListTodoMicro = micro(ListTodo);
export const IconMessageMicro = micro(MessageCircle);
export const IconMicMicro = micro(Mic);
export const IconOrderedListMicro = micro(ListOrdered);
export const IconQuoteMicro = micro(TextQuote);
export const IconSendMicro = micro(Send);
export const IconSparkleMicro = micro(Sparkles);
export const IconStopFilledMicro = (props: IconProps) => (
	<Square size={20} strokeWidth={2.4} fill="currentColor" {...props} />
);
export const IconStrikeMicro = micro(Strikethrough);
export const IconTextMicro = micro(Baseline);
export const IconUnderlineMicro = micro(Underline);
export const IconXMicro = micro(X);

/** SVG markup for emoji-mart's category navigation, which only accepts strings. */
export const emojiCategoryIcons = {
	frequent: ClockSvg,
	people: FaceSvg,
	nature: LeafSvg,
	foods: HamburgerSvg,
	activity: VolleyballSvg,
	places: GlobeSvg,
	objects: LightbulbSvg,
	symbols: HashSvg,
	flags: FlagSvg,
};
