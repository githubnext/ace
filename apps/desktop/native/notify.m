#import <Cocoa/Cocoa.h>
#import <UserNotifications/UserNotifications.h>

typedef void (*AceNotifyClicked)(void);

@interface AceNotify : NSObject <UNUserNotificationCenterDelegate>
@property AceNotifyClicked clicked;
/** What the last clicked notification opens; the callback only signals, since it runs later on Bun's thread. */
@property NSString *target;
@end

@implementation AceNotify
// Ace notifies only while none of its windows is focused, which can still be while it is active.
- (void)userNotificationCenter:(UNUserNotificationCenter *)center willPresentNotification:(UNNotification *)notification withCompletionHandler:(void (^)(UNNotificationPresentationOptions))handler {
	handler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList | UNNotificationPresentationOptionSound);
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center didReceiveNotificationResponse:(UNNotificationResponse *)response withCompletionHandler:(void (^)(void))handler {
	NSString *target = response.notification.request.content.userInfo[@"target"];
	if ([response.actionIdentifier isEqual:UNNotificationDefaultActionIdentifier]) {
		[NSApp activateIgnoringOtherApps:YES];
		self.target = target ?: @"";
		self.clicked();
	}
	handler();
}
@end

static AceNotify *notify;

void ace_notify_start(AceNotifyClicked clicked) {
	dispatch_sync(dispatch_get_main_queue(), ^{
		notify = [AceNotify new];
		notify.clicked = clicked;
		UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
		center.delegate = notify;
		[center requestAuthorizationWithOptions:UNAuthorizationOptionAlert | UNAuthorizationOptionSound completionHandler:^(BOOL granted, NSError *error) {
			if (error) NSLog(@"Ace notifications: %@", error);
		}];
	});
}

const char *ace_notify_clicked(void) {
	__block const char *target;
	dispatch_sync(dispatch_get_main_queue(), ^{ target = notify.target.UTF8String ?: ""; });
	return target;
}

/** `target` is what a click opens, such as a channel's id; empty opens Ace. */
void ace_notify(const char *title, const char *body, const char *target) {
	UNMutableNotificationContent *content = [UNMutableNotificationContent new];
	content.title = @(title);
	content.body = @(body);
	content.sound = UNNotificationSound.defaultSound;
	content.userInfo = @{@"target": @(target)};
	UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:NSUUID.UUID.UUIDString content:content trigger:nil];
	[UNUserNotificationCenter.currentNotificationCenter addNotificationRequest:request withCompletionHandler:^(NSError *error) {
		if (error) NSLog(@"Ace notification failed: %@", error);
	}];
}
