#import <Cocoa/Cocoa.h>
#import <CoreMedia/CoreMedia.h>
#import <QuartzCore/QuartzCore.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

// A live view draws another app's window over a pane natively: ScreenCaptureKit delivers frames
// as IOSurfaces at the display's rate, and the layer shows them without copying them through the
// page. Covered windows still capture; minimized ones and those on other Spaces don't.

@interface AceLiveView : NSView <SCStreamOutput, SCStreamDelegate>
@property(nonatomic) CGWindowID target;
/** The window being captured, which differs from `target` after a relink. */
@property(nonatomic) CGWindowID current;
/** The app that owns `current`, so a relink can find its new window. */
@property(nonatomic, copy) NSString *bundle;
@property(nonatomic, strong) SCStream *stream;
@property(nonatomic, strong) NSTimer *watch;
@property(nonatomic) BOOL stopped;
@property(nonatomic) BOOL lost;
/** Until when a closed window's app is followed to its next window, as after a rebuild. */
@property(nonatomic, strong) NSDate *deadline;
/** Bumped by each start or relink, so a slow lookup can't attach a superseded window. */
@property(nonatomic) NSUInteger generation;
@end

static BOOL exists(CGWindowID window) {
	const void *values[] = {(const void *)(uintptr_t)window};
	CFArrayRef ids = CFArrayCreate(NULL, values, 1, NULL);
	CFArrayRef found = CGWindowListCreateDescriptionFromArray(ids);
	BOOL result = found && CFArrayGetCount(found) > 0;
	if (found) CFRelease(found);
	CFRelease(ids);
	return result;
}

@implementation AceLiveView

- (instancetype)initWithFrame:(NSRect)frame {
	self = [super initWithFrame:frame];
	self.wantsLayer = YES;
	self.layer.contentsGravity = kCAGravityResizeAspect;
	self.layer.backgroundColor = NSColor.clearColor.CGColor;
	self.layer.cornerRadius = 8;
	self.layer.masksToBounds = YES;
	return self;
}

// The pane underneath stays the page's: clicks and scrolls pass through to it.
- (NSView *)hitTest:(NSPoint)point {
	return nil;
}

- (void)start:(CGWindowID)target {
	// A lost view waits for a relink rather than retrying every frame.
	BOOL same = self.target == target || self.current == target;
	if (same && (!self.stopped || self.lost)) {
		self.target = target;
		return;
	}
	[self stop];
	self.target = target;
	self.bundle = nil;
	self.deadline = nil;
	self.layer.contents = nil;
	[self attach:nil];
}

// Relinks to `app`'s largest normal window, for after it relaunched with a new window ID.
- (void)relink:(NSString *)app {
	NSString *bundle = self.bundle ?: app;
	[self stop];
	[self attach:bundle];
}

// Attaches the target window, or with `app`, that app's largest normal window.
- (void)attach:(NSString *)app {
	self.stopped = NO;
	self.lost = NO;
	NSUInteger generation = ++self.generation;
	CGWindowID target = self.target;
	[SCShareableContent getShareableContentExcludingDesktopWindows:YES
		onScreenWindowsOnly:NO
		completionHandler:^(SCShareableContent *content, NSError *error) {
			SCWindow *window = nil;
			for (SCWindow *item in content.windows) {
				if (app) {
					if (![item.owningApplication.bundleIdentifier isEqualToString:app]) continue;
					// Helper windows are tiny or off the normal layer.
					if (item.windowLayer != 0 || item.frame.size.width < 100) continue;
					if (!window || item.frame.size.width * item.frame.size.height
						> window.frame.size.width * window.frame.size.height) window = item;
				} else if (item.windowID == target) {
					window = item;
				}
			}
			dispatch_async(dispatch_get_main_queue(), ^{
				if (self.stopped || self.generation != generation) return;
				if (error || !window) return [self lose];
				[self capture:window];
			});
		}];
}

- (void)capture:(SCWindow *)window {
	self.bundle = window.owningApplication.bundleIdentifier;
	self.current = window.windowID;
	self.deadline = nil;
	SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
	SCStreamConfiguration *config = [SCStreamConfiguration new];
	CGFloat scale = filter.pointPixelScale;
	config.width = (size_t)(filter.contentRect.size.width * scale);
	config.height = (size_t)(filter.contentRect.size.height * scale);
	config.minimumFrameInterval = CMTimeMake(1, 60);
	config.queueDepth = 4;
	config.showsCursor = NO;
	config.pixelFormat = 'BGRA';
	config.colorSpaceName = kCGColorSpaceSRGB;
	SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:self];
	NSError *added = nil;
	[stream addStreamOutput:self
		type:SCStreamOutputTypeScreen
		sampleHandlerQueue:dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0)
		error:&added];
	if (added) return [self lose];
	self.stream = stream;
	// A closed window's stream goes quiet without reporting an error, so poll for it.
	self.watch = [NSTimer scheduledTimerWithTimeInterval:1 repeats:YES block:^(NSTimer *timer) {
		if (self.stream != stream || exists(self.current)) return;
		[self lost:stream];
	}];
	[stream startCaptureWithCompletionHandler:^(NSError *failed) {
		if (!failed) return;
		NSLog(@"Ace live view: %@", failed);
		[self lost:stream];
	}];
}

- (void)lost:(SCStream *)stream {
	dispatch_async(dispatch_get_main_queue(), ^{
		if (self.stream == stream) [self lose];
	});
}

// A rebuilt app relaunches with a new window ID, so its app is followed for a while, keeping the
// last frame, before the page's relink prompt shows underneath.
- (void)lose {
	[self stop];
	if (!self.bundle) return [self give];
	if (!self.deadline) self.deadline = [NSDate dateWithTimeIntervalSinceNow:10];
	if (self.deadline.timeIntervalSinceNow <= 0) return [self give];
	self.stopped = NO;
	NSUInteger generation = self.generation;
	dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 2), dispatch_get_main_queue(), ^{
		if (!self.stopped && self.generation == generation) [self attach:self.bundle];
	});
}

- (void)give {
	self.deadline = nil;
	self.lost = YES;
	self.layer.contents = nil;
}

- (void)stop {
	self.stopped = YES;
	[self.watch invalidate];
	self.watch = nil;
	SCStream *stream = self.stream;
	self.stream = nil;
	[stream stopCaptureWithCompletionHandler:nil];
}

- (void)stream:(SCStream *)stream
	didOutputSampleBuffer:(CMSampleBufferRef)buffer
	ofType:(SCStreamOutputType)type {
	if (type != SCStreamOutputTypeScreen || !CMSampleBufferIsValid(buffer)) return;
	// Frames with no new content carry no pixel buffer.
	CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, NO);
	if (attachments && CFArrayGetCount(attachments)) {
		NSDictionary *info = (__bridge NSDictionary *)CFArrayGetValueAtIndex(attachments, 0);
		NSNumber *status = info[SCStreamFrameInfoStatus];
		if (status && status.integerValue != SCFrameStatusComplete) return;
	}
	CVPixelBufferRef pixels = CMSampleBufferGetImageBuffer(buffer);
	if (!pixels) return;
	IOSurfaceRef surface = CVPixelBufferGetIOSurface(pixels);
	if (!surface) return;
	id contents = (__bridge id)surface;
	dispatch_async(dispatch_get_main_queue(), ^{
		if (self.stream != stream) return;
		[CATransaction begin];
		[CATransaction setDisableActions:YES];
		self.layer.contents = contents;
		[CATransaction commit];
	});
}

// The window closed or its app quit.
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
	NSLog(@"Ace live view stopped: %@", error);
	[self lost:stream];
}

@end

static NSMutableDictionary<NSString *, AceLiveView *> *views(void) {
	static NSMutableDictionary *value;
	static dispatch_once_t once;
	dispatch_once(&once, ^{ value = [NSMutableDictionary new]; });
	return value;
}

/**
 * Shows `target` at the page's CSS rect (top-left origin, in points) within the window, and
 * returns "wait", "lost", or "live <window> <bundle>". The text lasts until the next call.
 */
const char *ace_live_show(void *pointer, const char *key, uint32_t target, double x, double y, double w, double h) {
	NSString *id = [NSString stringWithUTF8String:key];
	static char status[512];
	dispatch_sync(dispatch_get_main_queue(), ^{
		NSWindow *window = (__bridge NSWindow *)pointer;
		NSView *content = window.contentView;
		NSRect frame = NSMakeRect(x, content.bounds.size.height - y - h, w, h);
		AceLiveView *view = views()[id];
		if (!view || view.window != window) {
			[view stop];
			[view removeFromSuperview];
			view = [[AceLiveView alloc] initWithFrame:frame];
			views()[id] = view;
			[content addSubview:view positioned:NSWindowAbove relativeTo:nil];
		}
		// Resizing the window re-stacks the webview above other subviews.
		if (content.subviews.lastObject != view) {
			[content addSubview:view positioned:NSWindowAbove relativeTo:nil];
		}
		view.frame = frame;
		[view start:target];
		view.hidden = view.lost;
		NSString *text = view.lost ? @"lost"
			: view.stream ? [NSString stringWithFormat:@"live %u %@", view.current, view.bundle]
			: @"wait";
		strlcpy(status, text.UTF8String, sizeof status);
	});
	return status;
}

/** Relinks a lost view to its app's current window; `app` is the bundle if this process never saw it. */
void ace_live_relink(const char *key, const char *app) {
	NSString *id = [NSString stringWithUTF8String:key];
	NSString *bundle = app[0] ? [NSString stringWithUTF8String:app] : nil;
	dispatch_sync(dispatch_get_main_queue(), ^{
		AceLiveView *view = views()[id];
		if (view.bundle || bundle) [view relink:bundle];
	});
}

void ace_live_hide(const char *key) {
	NSString *id = [NSString stringWithUTF8String:key];
	dispatch_sync(dispatch_get_main_queue(), ^{
		AceLiveView *view = views()[id];
		if (!view) return;
		[view stop];
		[view removeFromSuperview];
		[views() removeObjectForKey:id];
	});
}
