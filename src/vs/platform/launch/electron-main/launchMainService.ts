/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { coalesce } from 'vs/base/common/arrays';
import { IProcessEnvironment, isMacintosh } from 'vs/base/common/platform';
import { URI } from 'vs/base/common/uri';
import { whenDeleted } from 'vs/base/node/pfs';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { NativeParsedArgs } from 'vs/platform/environment/common/argv';
import { isLaunchedFromCli } from 'vs/platform/environment/node/argvHelper';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { ILogService } from 'vs/platform/log/common/log';
import { IURLService } from 'vs/platform/url/common/url';
import { ICodeWindow } from 'vs/platform/window/electron-main/window';
import { IWindowSettings } from 'vs/platform/window/common/window';
import { IOpenConfiguration, IWindowsMainService, OpenContext } from 'vs/platform/windows/electron-main/windows';
import { IUserDataProfilesMainService } from 'vs/platform/userDataProfile/electron-main/userDataProfile';

export const ID = 'launchMainService';
export const ILaunchMainService = createDecorator<ILaunchMainService>(ID);

export interface IStartArguments {
	readonly args: NativeParsedArgs;
	readonly userEnv: IProcessEnvironment;
}

export interface ILaunchMainService {

	readonly _serviceBrand: undefined;

	start(args: NativeParsedArgs, userEnv: IProcessEnvironment): Promise<void>;

	getMainProcessId(): Promise<number>;
}

export class LaunchMainService implements ILaunchMainService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@IURLService private readonly urlService: IURLService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IUserDataProfilesMainService private readonly userDataProfilesMainService: IUserDataProfilesMainService,
	) { }

	async start(args: NativeParsedArgs, userEnv: IProcessEnvironment): Promise<void> {
		this.logService.trace('Received data from other instance: ', args, userEnv);

		// macOS: Electron > 7.x changed its behaviour to not
		// bring the application to the foreground when a window
		// is focused programmatically. Only via `app.focus` and
		// the option `steal: true` can you get the previous
		// behaviour back. The only reason to use this option is
		// when a window is getting focused while the application
		// is not in the foreground and since we got instructed
		// to open a new window from another instance, we ensure
		// that the app has focus.
		if (isMacintosh) {
			app.focus({ steal: true });
		}

		// Check early for open-url which is handled in URL service
		const urlsToOpen = this.parseOpenUrl(args);
		if (urlsToOpen.length) {
			let whenWindowReady: Promise<unknown> = Promise.resolve();

			// Create a window if there is none
			if (this.windowsMainService.getWindowCount() === 0) {
				const window = this.windowsMainService.openEmptyWindow({ context: OpenContext.DESKTOP })[0];
				whenWindowReady = window.ready();
			}

			// Make sure a window is open, ready to receive the url event
			whenWindowReady.then(() => {
				for (const { uri, url } of urlsToOpen) {
					this.urlService.open(uri, { originalUrl: url });
				}
			});
		}

		// Otherwise handle in windows service
		else {
			return this.startOpenWindow(args, userEnv);
		}
	}

	private parseOpenUrl(args: NativeParsedArgs): { uri: URI; url: string }[] {
		if (args['open-url'] && args._urls && args._urls.length > 0) {

			// --open-url must contain -- followed by the url(s)
			// process.argv is used over args._ as args._ are resolved to file paths at this point

			return coalesce(args._urls
				.map(url => {
					try {
						return { uri: URI.parse(url), url };
					} catch (err) {
						return null;
					}
				}));
		}

		return [];
	}

	private async startOpenWindow(args: NativeParsedArgs, userEnv: IProcessEnvironment): Promise<void> {
		const context = isLaunchedFromCli(userEnv) ? OpenContext.CLI : OpenContext.DESKTOP;
		let usedWindows: ICodeWindow[] = [];

		const waitMarkerFileURI = args.wait && args.waitMarkerFilePath ? URI.file(args.waitMarkerFilePath) : undefined;
		const remoteAuthority = args.remote || undefined;

		// Ensure profile exists when passed in from CLI
		const profilePromise = this.userDataProfilesMainService.checkAndCreateProfileFromCli(args);
		const profile = profilePromise ? await profilePromise : undefined;

		const baseConfig: IOpenConfiguration = {
			context,
			cli: args,
			userEnv,
			waitMarkerFileURI,
			remoteAuthority,
			profile
		};

		// Special case extension development
		if (!!args.extensionDevelopmentPath) {
			this.windowsMainService.openExtensionDevelopmentHostWindow(args.extensionDevelopmentPath, baseConfig);
		}

		// Start without file/folder arguments
		else if (!args._.length && !args['folder-uri'] && !args['file-uri']) {
			let openNewWindow = false;

			// Force new window
			if (args['new-window'] || args['unity-launch'] || profile) {
				openNewWindow = true;
			}

			// Force reuse window
			else if (args['reuse-window']) {
				openNewWindow = false;
			}

			// Otherwise check for settings
			else {
				const windowConfig = this.configurationService.getValue<IWindowSettings | undefined>('window');
				const openWithoutArgumentsInNewWindowConfig = windowConfig?.openWithoutArgumentsInNewWindow || 'default' /* default */;
				switch (openWithoutArgumentsInNewWindowConfig) {
					case 'on':
						openNewWindow = true;
						break;
					case 'off':
						openNewWindow = false;
						break;
					default:
						openNewWindow = !isMacintosh; // prefer to restore running instance on macOS
				}
			}

			// Open new Window
			if (openNewWindow) {
				usedWindows = this.windowsMainService.open({
					...baseConfig,
					forceNewWindow: true,
					forceEmpty: true
				});
			}

			// Focus existing window or open if none opened
			else {
				const lastActive = this.windowsMainService.getLastActiveWindow();
				if (lastActive) {
					this.windowsMainService.openExistingWindow(lastActive, baseConfig);

					usedWindows = [lastActive];
				} else {
					usedWindows = this.windowsMainService.open({
						...baseConfig,
						forceEmpty: true
					});
				}
			}
		}

		// Start with file/folder arguments
		else {
			usedWindows = this.windowsMainService.open({
				...baseConfig,
				forceNewWindow: args['new-window'],
				preferNewWindow: !args['reuse-window'] && !args.wait,
				forceReuseWindow: args['reuse-window'],
				diffMode: args.diff,
				mergeMode: args.merge,
				addMode: args.add,
				noRecentEntry: !!args['skip-add-to-recently-opened'],
				gotoLineMode: args.goto
			});
		}

		// If the other instance is waiting to be killed, we hook up a window listener if one window
		// is being used and only then resolve the startup promise which will kill this second instance.
		// In addition, we poll for the wait marker file to be deleted to return.
		if (waitMarkerFileURI && usedWindows.length === 1 && usedWindows[0]) {
			return Promise.race([
				usedWindows[0].whenClosedOrLoaded,
				whenDeleted(waitMarkerFileURI.fsPath)
			]).then(() => undefined, () => undefined);
		}
	}

	async getMainProcessId(): Promise<number> {
		this.logService.trace('Received request for process ID from other instance.');

		return process.pid;
	}
}
