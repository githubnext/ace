// Components
export { AceAvatar, type AceAvatarProps } from "./components/ace-avatar/ace-avatar";
export { Nav } from "./components/app-layout/nav";
export { NavList } from "./components/app-layout/nav-list";
export { NavListLink } from "./components/app-layout/nav-list-link";
export { Panel } from "./components/app-layout/panel";
export { AppearanceProvider, useAppearance } from "./components/appearance";
export { ChatStatus, type ChatStatusProps } from "./components/chat-status/chat-status";
export {
	CommandPalette,
	type CommandPaletteProps,
} from "./components/command-palette/command-palette";
export type {
	CommandPaletteCommandItem,
	CommandPaletteItem,
	CommandPaletteSessionItem,
	CommandPaletteSessionStatus,
	CommandPaletteShortcut,
} from "./components/command-palette/types";
export type { Attachment } from "./components/composer/attachment-list";
export {
	type Agent,
	ChatComposer,
	type ChatComposerHandle,
	type SendPayload,
} from "./components/composer/chat-composer";
export { Composer } from "./components/composer/composer";
export { type Mention } from "./components/composer/editor";
export { canSendMessage } from "./components/composer/send";
export {
	DiffView,
	type DiffViewFile,
	type DiffViewMode,
	type DiffViewPr,
	type DiffViewProps,
} from "./components/diff/diff-view";
export { Facepile, type FacepileAvatar, type FacepileProps } from "./components/facepile/facepile";
export { FileView, type FileViewProps } from "./components/file/file-view";
export {
	Layout,
	Main,
	Sidebar,
	useLayoutLeft,
	useLayoutLeftWidth,
	useLayoutNav,
	useLayoutRight,
} from "./components/layout/layout";
export { LayoutBackground } from "./components/layout/layout-background";
export { LayoutCanvas } from "./components/layout/layout-canvas";
export { Logo, type LogoProps } from "./components/logo/logo";
export { MarqueeText } from "./components/marquee/marquee-text";
export { ApprovalView, type ApprovalViewProps } from "./components/requests/approval";
export {
	type QuestionDraft,
	type QuestionForm,
	type QuestionItem,
	QuestionView,
	type QuestionViewHandle,
	type QuestionViewProps,
} from "./components/requests/question";
export { QuestionInput } from "./components/requests/question-input";
export { isAnswered } from "./components/requests/question-state";
export {
	ScrollView,
	type ScrollViewHandle,
	type ScrollViewProps,
	type ScrollViewRange,
} from "./components/scroll-view/scroll-view";
export {
	type DetailsFact,
	type DetailsLink,
	type DetailsPull,
	type DetailsSubagent,
	SessionDetailsView,
	type SessionDetailsViewProps,
} from "./components/session-details/session-details";
export type { MoveTarget, SidebarRow } from "./components/session-item/session-item.types";
export {
	ProjectPicker,
	ProjectSidebar,
	SessionSidebar,
	type SessionSidebarGroup,
	type SessionSidebarGroupId,
	type SessionSidebarProps,
	type SessionSidebarRepo,
} from "./components/session-sidebar/session-sidebar";
export {
	type SessionSidebarRepoToggle,
	SessionSidebarUnified,
	type SessionSidebarUnifiedGroup,
	type SessionSidebarUnifiedGroupId,
	type SessionSidebarUnifiedProps,
	type SessionSidebarUnifiedRepoSection,
} from "./components/session-sidebar/session-sidebar-unified";
export { ThemeProvider, useResolvedTheme, useTheme } from "./components/theme";
export {
	Timeline,
	type TimelineExec,
	type TimelineExecAction,
	type TimelineProps,
	type TimelineVisibility,
} from "./components/timeline/timeline";
export { TurnSummary } from "./components/turn-summary/turn-summary";
export { TypingDots, type TypingDotsProps } from "./components/typing-dots/typing-dots";
export { UserMenu } from "./components/user-menu/user-menu";
export { type DocumentCandidate } from "./lib/references";
export type { TimelineWorking } from "./lib/timeline";
export { Waveform } from "./ui/waveform";

// UI
export { toast } from "sonner";
export { Dither } from "./components/dither";
export { Divider } from "./components/divider";
export { buttonVariants } from "./lib/button-variants";
export { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
export { Badge } from "./ui/badge";
export { Button } from "./ui/button";
export {
	ContextMenu,
	ContextMenuContent,
	ContextMenuGroup,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuShortcut,
	ContextMenuTrigger,
} from "./ui/context-menu";
export {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogOverlay,
	DialogPortal,
	DialogTitle,
	DialogTrigger,
} from "./ui/dialog";
export {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";
export {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "./ui/empty";
export { Field, FieldGroup, FieldLabel } from "./ui/field";
export { Input } from "./ui/input";
export {
	Popover,
	PopoverContent,
	PopoverPopup,
	PopoverPortal,
	PopoverPositioner,
	PopoverTrigger,
} from "./ui/popover";
export { Skeleton } from "./ui/skeleton";
export { Toaster, type ToasterProps } from "./ui/sonner";
export { SplitButton, type SplitButtonProps } from "./ui/split-button";
export { Switch } from "./ui/switch";
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

// Hooks
export { useDraft } from "./hooks/use-draft";
export { useHistory } from "./hooks/use-history";
export { useLocalStorage } from "./hooks/use-local-storage";
export { useMedia } from "./hooks/use-media";
export { useMic, useMicLevel } from "./hooks/use-mic";
export { useResizing } from "./hooks/use-resizing";
export { useSuppressMotion } from "./hooks/use-suppress-motion";
export { agentColor, agentLabel } from "./lib/agent";
export { aceAvatar, aceLogo } from "./lib/emoji";
export { glow, type GlowPreset, type GlowScheme, type GlowTone } from "./lib/glow";
export { media, screen } from "./lib/screens";
export { frame, visible } from "./lib/scroll";

// Types
export type { Appearance } from "./components/appearance";
export type { Theme } from "./components/theme";
export type * from "./types";
