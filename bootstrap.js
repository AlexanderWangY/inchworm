/* global Zotero, Services, APP_SHUTDOWN */
var Inchworm;
var InchwormLines;
var InchwormMarks;

function log(msg) {
	Zotero.debug('Inchworm: ' + msg);
}

function loadScript(rootURI, path) {
	// allowUnsafeURL is ignored on Firefox 140 and needed on Zotero 11 (Firefox 153)
	Services.scriptloader.loadSubScriptWithOptions(rootURI + path, {
		ignoreCache: true,
		allowUnsafeURL: true,
	});
}

function install() {}

async function startup({ id, version, rootURI }) {
	log(`starting ${version}`);
	loadScript(rootURI, 'src/lines.js');
	loadScript(rootURI, 'src/marks.js');
	loadScript(rootURI, 'src/inchworm.js');
	await Inchworm.startup({ id, version, rootURI });
}

function onMainWindowLoad() {}

function onMainWindowUnload() {}

async function shutdown(data, reason) {
	log('shutting down');
	if (reason === APP_SHUTDOWN) {
		// Zotero is quitting: just make sure bookmarks are on disk
		await InchwormMarks?.flush();
		return;
	}
	await Inchworm?.shutdown();
	Inchworm = undefined;
	InchwormLines = undefined;
	InchwormMarks = undefined;
}

function uninstall() {}
