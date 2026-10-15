#import <Cocoa/Cocoa.h>
#import <Sparkle/Sparkle.h>

@interface AceUpdates : NSObject <SPUUserDriver, SPUUpdaterDelegate>
@property SPUUpdater *updater;
@property NSMutableDictionary *state;
@property(copy) void (^choice)(SPUUserUpdateChoice);
@property(copy) void (^cancel)(void);
@property uint64_t expected;
@property uint64_t received;
@end

@implementation AceUpdates
- (instancetype)init {
	self = [super init];
	if (!self) return nil;
	_state = [@{@"phase": @"idle"} mutableCopy];
	NSBundle *bundle = NSBundle.mainBundle;
	if (![bundle objectForInfoDictionaryKey:@"SUFeedURL"]) {
		_state[@"phase"] = @"disabled";
		return self;
	}
	_updater = [[SPUUpdater alloc] initWithHostBundle:bundle applicationBundle:bundle userDriver:self delegate:self];
	NSError *error;
	if (![_updater startUpdater:&error]) [self fail:error];
	return self;
}

- (void)fail:(NSError *)error {
	NSString *phase = self.state[@"phase"];
	// Sparkle replaces the app only after Ace answers Install in showReadyToInstallAndRelaunch.
	BOOL unchanged = [phase isEqual:@"downloading"] || [phase isEqual:@"installing"];
	self.state[@"phase"] = @"error";
	self.state[@"error"] = unchanged ? [error.localizedDescription stringByAppendingString:@" Ace was not changed."] : error.localizedDescription;
	self.choice = nil;
	self.cancel = nil;
}

- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)request reply:(void (^)(SUUpdatePermissionResponse *))reply {
	reply([[SUUpdatePermissionResponse alloc] initWithAutomaticUpdateChecks:YES automaticUpdateDownloading:@NO sendSystemProfile:NO]);
}

- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancellation {
	self.state[@"phase"] = @"checking";
	[self.state removeObjectForKey:@"error"];
	self.cancel = cancellation;
}

- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)item state:(SPUUserUpdateState *)state reply:(void (^)(SPUUserUpdateChoice))reply {
	self.cancel = nil;
	if (item.informationOnlyUpdate || state.stage != SPUUserUpdateStageNotDownloaded) {
		// Never resume an install staged outside Ace's helper handoff.
		reply(SPUUserUpdateChoiceSkip);
		[self fail:[NSError errorWithDomain:@"AceUpdates" code:1 userInfo:@{NSLocalizedDescriptionKey: @"This update cannot be installed automatically. Check for updates again or download a new copy of Ace."}]];
		return;
	}
	self.state[@"phase"] = @"available";
	[self.state removeObjectForKey:@"error"];
	self.state[@"available"] = item.displayVersionString;
	self.choice = reply;
}

- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData *)data {}
- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError *)error {}

- (void)showUpdateNotFoundWithError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement {
	self.state[@"phase"] = @"idle";
	[self.state removeObjectForKey:@"error"];
	acknowledgement();
}

- (void)showUpdaterError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement {
	[self fail:error];
	acknowledgement();
}

- (void)showDownloadInitiatedWithCancellation:(void (^)(void))cancellation {
	self.state[@"phase"] = @"downloading";
	self.cancel = cancellation;
	self.expected = 0;
	self.received = 0;
	[self.state removeObjectForKey:@"progress"];
}

- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)length { self.expected = length; }
- (void)showDownloadDidReceiveDataOfLength:(uint64_t)length {
	self.received += length;
	if (self.expected) self.state[@"progress"] = @(MIN(1.0, (double)self.received / self.expected));
}

- (void)showDownloadDidStartExtractingUpdate {
	self.cancel = nil;
	self.state[@"phase"] = @"installing";
	[self.state removeObjectForKey:@"progress"];
}
- (void)showExtractionReceivedProgress:(double)progress {}

- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply {
	// Ace Helper and every local worker are already stopped before download begins.
	self.state[@"phase"] = @"restarting";
	reply(SPUUserUpdateChoiceInstall);
}

- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)terminated retryTerminatingApplication:(void (^)(void))retry {
	self.state[@"phase"] = @"restarting";
}

- (void)showUpdateInstalledAndRelaunched:(BOOL)relaunched acknowledgement:(void (^)(void))acknowledgement {
	acknowledgement();
}

- (void)dismissUpdateInstallation {
	self.choice = nil;
	self.cancel = nil;
}

- (BOOL)updater:(SPUUpdater *)updater shouldDownloadReleaseNotesForUpdate:(SUAppcastItem *)item { return NO; }

- (NSString *)feedURLStringForUpdater:(SPUUpdater *)updater {
	return [NSBundle.mainBundle objectForInfoDictionaryKey:@"SUFeedURL"];
}

- (void)updater:(SPUUpdater *)updater didFinishUpdateCycleForUpdateCheck:(SPUUpdateCheck)check error:(NSError *)error {
	if (error.code == SUNoUpdateError) {
		self.state[@"phase"] = @"idle";
		[self.state removeObjectForKey:@"error"];
	} else if (error) {
		// showUpdaterError already reported this error with what it left unchanged.
		if (![self.state[@"phase"] isEqual:@"error"]) [self fail:error];
	} else if (![self.state[@"phase"] isEqual:@"restarting"] && ![self.state[@"phase"] isEqual:@"error"]) self.state[@"phase"] = @"idle";
}
@end

static AceUpdates *updates;
static NSString *snapshot;

void ace_updates_start(void) {
	dispatch_sync(dispatch_get_main_queue(), ^{ if (!updates) updates = [AceUpdates new]; });
}

const char *ace_updates_status(void) {
	dispatch_sync(dispatch_get_main_queue(), ^{
		NSMutableDictionary *state = [updates.state mutableCopy];
		state[@"automatic"] = @(updates.updater.automaticallyChecksForUpdates);
		state[@"canCancel"] = updates.cancel ? @YES : @NO;
		if (updates.updater.lastUpdateCheckDate) state[@"checked"] = @([updates.updater.lastUpdateCheckDate timeIntervalSince1970] * 1000);
		NSData *data = [NSJSONSerialization dataWithJSONObject:state options:0 error:nil];
		snapshot = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
	});
	return snapshot.UTF8String;
}

bool ace_updates_action(int action) {
	__block BOOL accepted = NO;
	dispatch_sync(dispatch_get_main_queue(), ^{
		NSString *phase = updates.state[@"phase"];
		if (!updates.updater) return;
		if (action == 0 && !updates.updater.sessionInProgress) {
			[updates.state removeObjectForKey:@"error"];
			[updates.state removeObjectForKey:@"available"];
			[updates.updater checkForUpdates];
			accepted = YES;
		} else if (action == 1 && [phase isEqual:@"available"] && updates.choice) {
			updates.state[@"phase"] = @"preparing";
			accepted = YES;
		} else if (action == 2 && [phase isEqual:@"preparing"] && updates.choice) {
			void (^choice)(SPUUserUpdateChoice) = updates.choice;
			updates.choice = nil;
			choice(SPUUserUpdateChoiceInstall);
			accepted = YES;
		} else if (action == 3 && (updates.cancel || updates.choice)) {
			void (^cancel)(void) = updates.cancel;
			void (^choice)(SPUUserUpdateChoice) = updates.choice;
			updates.cancel = nil;
			updates.choice = nil;
			if (cancel) cancel();
			if (choice) choice(SPUUserUpdateChoiceDismiss);
			updates.state[@"phase"] = @"idle";
			accepted = YES;
		} else if (action == 4 || action == 5) {
			updates.updater.automaticallyChecksForUpdates = action == 5;
			accepted = YES;
		}
	});
	return accepted;
}
