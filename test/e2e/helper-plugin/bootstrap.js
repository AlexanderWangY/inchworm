/* global Zotero, Services */
// Marionette and the Remote Agent hold back WebDriver:NewSession until the app
// sends Firefox's (or Thunderbird's) "idle startup tasks finished" signal.
// Zotero sends neither, so send it once the UI is ready. Test profiles only.
function startup() {
	Zotero.uiReadyPromise.then(() => {
		Services.obs.notifyObservers(null, 'browser-idle-startup-tasks-finished');
	});
}

function shutdown() {}

function install() {}

function uninstall() {}
