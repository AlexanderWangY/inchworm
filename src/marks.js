/*
 * Inchworm — bookmark ("mark") storage.
 *
 * Marks live in <Zotero data directory>/inchworm/marks.json:
 *
 *   {
 *     "version": 1,
 *     "items":  { "<libraryID>/<attachmentKey>": { "marks": { "a": Mark, "'": Mark, "\"": Mark } } },
 *     "global": { "A": Mark & { libraryID, itemKey, title } }
 *   }
 *
 * Mark = { pageIndex, rect: [x1, y1, x2, y2] (PDF points), text, pageLabel, time }
 *
 * Lowercase letters are per-paper, uppercase letters are global (they remember
 * which paper they belong to), `'` is "where I was before the last jump" and
 * `"` is "where the cursor was last".
 */
/* global Zotero, IOUtils, PathUtils, setTimeout, clearTimeout */
var InchwormMarks = (function () {
	'use strict';

	const SAVE_DELAY = 1000;

	let data = emptyData();
	let filePath = null;
	let saveTimer = null;
	let dirty = false;
	let saving = Promise.resolve();

	function emptyData() {
		return { version: 1, items: {}, global: {} };
	}

	function isGlobal(name) {
		return /^[A-Z]$/.test(name);
	}

	function isLetter(name) {
		return /^[a-zA-Z]$/.test(name);
	}

	function isObject(value) {
		return !!value && typeof value === 'object' && !Array.isArray(value);
	}

	function isMark(mark) {
		return isObject(mark) && Number.isInteger(mark.pageIndex)
			&& Array.isArray(mark.rect) && mark.rect.length === 4;
	}

	/** Keep only well-formed entries, so one bad record can't break the menu. */
	function sanitize(json) {
		let clean = emptyData();
		for (let [ref, entry] of Object.entries(isObject(json.items) ? json.items : {})) {
			let marks = {};
			for (let [name, mark] of Object.entries(isObject(entry) && isObject(entry.marks) ? entry.marks : {})) {
				if (isMark(mark)) {
					marks[name] = mark;
				}
			}
			clean.items[ref] = { marks };
		}
		for (let [name, mark] of Object.entries(isObject(json.global) ? json.global : {})) {
			if (isMark(mark) && mark.itemKey) {
				clean.global[name] = mark;
			}
		}
		return clean;
	}

	async function load(dir) {
		filePath = PathUtils.join(dir, 'marks.json');
		await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
		let json;
		try {
			json = await IOUtils.readJSON(filePath);
		}
		catch (e) {
			if (e.name === 'NotFoundError') {
				return;
			}
			Zotero.logError(e);
		}
		if (isObject(json) && json.version === 1) {
			data = sanitize(json);
			return;
		}
		// Unreadable, or written by a newer Inchworm: move it aside rather than overwrite it
		try {
			await IOUtils.move(filePath, filePath + '.unrecognized-' + Date.now());
		}
		catch (e) {
			Zotero.logError(e);
		}
	}

	function itemMarks(ref, create) {
		let entry = data.items[ref];
		if (!isObject(entry) || !isObject(entry.marks)) {
			if (!create) {
				return {};
			}
			entry = data.items[ref] = { marks: {} };
		}
		return entry.marks;
	}

	function get(ref, name) {
		if (isGlobal(name)) {
			return data.global[name] || null;
		}
		return itemMarks(ref, false)[name] || null;
	}

	function set(ref, name, mark) {
		if (isGlobal(name)) {
			data.global[name] = mark;
		}
		else {
			itemMarks(ref, true)[name] = mark;
		}
		scheduleSave();
	}

	function remove(ref, name) {
		if (isGlobal(name)) {
			delete data.global[name];
		}
		else {
			delete itemMarks(ref, false)[name];
		}
		scheduleSave();
	}

	/** Remove this paper's letter marks (keeps the `'` and `"` positions). */
	function clearItem(ref) {
		let marks = itemMarks(ref, false);
		for (let name of Object.keys(marks)) {
			if (isLetter(name)) {
				delete marks[name];
			}
		}
		scheduleSave();
	}

	/** This paper's a–z marks as [name, mark] pairs, sorted by name. */
	function list(ref) {
		return Object.entries(itemMarks(ref, false))
			.filter(([name]) => isLetter(name))
			.sort(([a], [b]) => a.localeCompare(b));
	}

	/** Global A–Z marks as [name, mark] pairs, sorted by name. */
	function listGlobal() {
		return Object.entries(data.global).sort(([a], [b]) => a.localeCompare(b));
	}

	function nextFree(ref) {
		let marks = itemMarks(ref, false);
		for (let code = 97; code <= 122; code++) {
			let name = String.fromCharCode(code);
			if (!marks[name]) {
				return name;
			}
		}
		return null;
	}

	function scheduleSave() {
		dirty = true;
		clearTimeout(saveTimer);
		saveTimer = setTimeout(flush, SAVE_DELAY);
	}

	function flush() {
		clearTimeout(saveTimer);
		saveTimer = null;
		if (!dirty || !filePath) {
			return saving;
		}
		dirty = false;
		let snapshot = JSON.parse(JSON.stringify(data));
		// Chain writes so an older snapshot can never land after a newer one
		saving = saving.then(() => IOUtils.writeJSON(filePath, snapshot, { tmpPath: filePath + '.tmp' }))
			.catch((e) => {
				Zotero.logError(e);
				// Try again with the next change
				dirty = true;
			});
		return saving;
	}

	return {
		load,
		get,
		set,
		remove,
		clearItem,
		list,
		listGlobal,
		nextFree,
		flush,
		isGlobal,
		get path() {
			return filePath;
		},
	};
})();
