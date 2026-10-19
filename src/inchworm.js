/*
 * Inchworm — vim-style line-by-line reading and bookmarks for Zotero's PDF reader.
 *
 * How it hooks in (Zotero 7–10):
 *
 *   ReaderTab ─ reader._iframeWindow                       reader.html (toolbar, sidebar)
 *            └ reader._internalReader._primaryView         PDFView (also _secondaryView in split view)
 *                 └ view._iframeWindow                     pdf.js viewer: PDFViewerApplication, page divs
 *
 * Both iframes are content documents, so we keep two handles on each window:
 * an Xray (`win`) for DOM work and a waived wrapper (`cwin`) for reaching the
 * reader's JS objects. Lines come from the reader's own per-page char data
 * (view._pdfPages[i].chars), which is already in reading order with
 * `lineBreakAfter` flags, so multi-column papers work without guessing.
 */
/* global Zotero, Components, InchwormLines, InchwormMarks, PathUtils,
   setTimeout, clearTimeout, setInterval, clearInterval */
var Inchworm = (function () {
	'use strict';

	const Cu = Components.utils;
	const PREF_BRANCH = 'extensions.inchworm.';
	const DEFAULTS = {
		style: 'highlight',
		color: '#ffd400',
		scrolloff: '25',
		skipMargins: true,
		clickToMove: true,
	};
	const STYLES = [
		['highlight', 'Highlight'],
		['underline', 'Underline'],
		['both', 'Highlight + underline'],
		['focus', 'Focus (dim everything else)'],
	];
	const CHAR_FIELDS = ['c', 'rect', 'inlineRect', 'rotation', 'lineBreakAfter',
		'paragraphBreakAfter', 'spaceAfter', 'isolated'];
	const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'CapsLock', 'Fn']);
	const PENDING_TIMEOUT = 2000;
	const TRANSITION = 'left 90ms ease-out, top 90ms ease-out, width 90ms ease-out, height 90ms ease-out';
	const HELP = [
		['j  /  k', 'next / previous line (5j moves five)'],
		['}  /  {', 'next / previous paragraph'],
		['H  M  L', 'top / middle / bottom of the screen'],
		['gg  /  G', 'first / last line (12G goes to page 12)'],
		['zz  zt  zb', 'scroll the line to center / top / bottom'],
		['m a–z', 'bookmark this line'],
		['m A–Z', 'bookmark that works across papers'],
		["' letter", 'jump to a bookmark'],
		["''", 'jump back to where you were'],
		['\'"', 'jump to where you left off last time'],
		['Esc', 'hide the line cursor'],
		['click', 'move the cursor (while it is showing)'],
		['?', 'show / hide this help'],
	];

	let pluginID = null;
	let rootURI = null;
	let tickTimer = null;
	let prefSymbols = [];
	let controllers = new Map();
	// False once the plugin shuts down, so late async work stops
	let alive = false;

	function pref(name) {
		let value = Zotero.Prefs.get(PREF_BRANCH + name, true);
		return value === undefined ? DEFAULTS[name] : value;
	}

	function setPref(name, value) {
		Zotero.Prefs.set(PREF_BRANCH + name, value, true);
	}

	function readers() {
		let list = Zotero.Reader && Zotero.Reader._readers;
		if (!list) {
			return [];
		}
		// An Array in every version so far; accept any iterable in case that changes
		return Array.isArray(list) ? list.slice() : Array.from(list.values ? list.values() : list);
	}

	function isEditable(target) {
		if (!target || target.nodeType !== 1) {
			return false;
		}
		if (target.isContentEditable) {
			return true;
		}
		let name = target.localName;
		if (name === 'input' || name === 'textarea' || name === 'select') {
			return true;
		}
		return !!target.closest('.textAnnotation, [contenteditable="true"], [contenteditable=""], [role="textbox"]');
	}

	/** The key pressed, turning US-International dead keys (' and `) into themselves. */
	function keyOf(event) {
		if (event.key === 'Dead') {
			if (event.code === 'Quote') {
				return event.shiftKey ? '"' : "'";
			}
			if (event.code === 'Backquote') {
				return '`';
			}
		}
		return event.key;
	}

	/** The letter on the physical key, for composed characters (á after a dead key). */
	function letterOf(event) {
		let m = /^Key([A-Z])$/.exec(event.code || '');
		return m ? (event.shiftKey ? m[1] : m[1].toLowerCase()) : null;
	}

	function hexToRgba(hex, alpha) {
		let m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
		let h = m ? m[1] : 'ffd400';
		if (h.length === 3) {
			h = h.split('').map(c => c + c).join('');
		}
		let n = parseInt(h, 16);
		return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
	}

	function truncate(text, max) {
		text = String(text || '');
		return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
	}

	function pct(value, total) {
		return (total ? value / total * 100 : 0) + '%';
	}

	function waitFor(fn, timeout) {
		let start = Date.now();
		return new Promise((resolve) => {
			let check = () => {
				let value = null;
				try {
					value = fn();
				}
				catch (e) {}
				if (value || !alive || Date.now() - start > timeout) {
					resolve((alive && value) || null);
					return;
				}
				setTimeout(check, 150);
			};
			check();
		});
	}

	function applyLineStyle(s, style, color, dark) {
		s.position = 'absolute';
		s.pointerEvents = 'none';
		s.zIndex = '25';
		s.boxSizing = 'border-box';
		s.borderRadius = '3px';
		s.background = 'transparent';
		s.borderBottom = '0';
		s.boxShadow = 'none';
		s.mixBlendMode = 'normal';
		if (style === 'underline' || style === 'both') {
			s.borderBottom = `2px solid ${color}`;
			s.borderRadius = '0';
		}
		if (style === 'highlight' || style === 'both') {
			s.background = hexToRgba(color, dark ? 0.35 : 0.45);
			s.mixBlendMode = dark ? 'screen' : 'multiply';
		}
		if (style === 'focus') {
			s.background = hexToRgba(color, 0.18);
			s.boxShadow = `0 0 0 100vmax ${dark ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0.28)'}`;
		}
	}

	function isReadyPdfView(view) {
		try {
			let w = Cu.waiveXrays(view)._iframeWindow;
			if (!w || Cu.isDeadWrapper(w)) {
				return false;
			}
			let app = w.PDFViewerApplication;
			return !!(app && app.pdfDocument && app.pdfViewer && app.pdfViewer.pagesCount > 0
				&& w.document && w.document.getElementById('viewerContainer'));
		}
		catch (e) {
			return false;
		}
	}

	/**
	 * One PDF view (the primary view, or the secondary one in split view):
	 * owns the line cache, the cursor, the overlay and the key handling.
	 */
	class ViewController {
		constructor(rc, view, which) {
			this.rc = rc;
			this.which = which;
			this.view = Cu.waiveXrays(view);
			this.cwin = Cu.waiveXrays(this.view._iframeWindow);
			this.win = Cu.unwaiveXrays(this.view._iframeWindow);
			this.doc = this.win.document;
			this.app = this.cwin.PDFViewerApplication;
			this.container = this.doc.getElementById('viewerContainer');

			this.cache = new Map();
			this.navCache = new Map();
			this.cursor = null;
			this.shown = false;
			this.pending = null;
			this.pendingCount = 0;
			this.count = '';
			this.pendingTimer = null;
			this.queue = Promise.resolve();
			this.busy = 0;
			// Bumped by hide() so motions still queued from before Escape are dropped
			this.generation = 0;
			this.disposed = false;
			this.welcomeTimer = null;
			this.overlay = null;
			this.watched = null;
			this.toastEl = null;
			this.toastTimer = null;
			this.hintShowing = false;
			this.helpEl = null;
			this.down = null;

			this.observer = new this.win.MutationObserver(() => this.onMutation());
			// Keys arrive via ReaderController, which listens before Zotero does
			this.onPointerDown = this.onPointerDown.bind(this);
			this.onPointerUp = this.onPointerUp.bind(this);
			this.win.addEventListener('pointerdown', this.onPointerDown, true);
			this.win.addEventListener('pointerup', this.onPointerUp, true);

			if (!Zotero.Prefs.get(PREF_BRANCH + 'welcomed', true)) {
				Zotero.Prefs.set(PREF_BRANCH + 'welcomed', true, true);
				this.welcomeTimer = setTimeout(() => {
					this.toast('Inchworm: press j / k to read line by line · ? for all keys', 6000);
				}, 800);
			}
		}

		isFor(view) {
			try {
				return Cu.waiveXrays(view) === this.view
					&& !Cu.isDeadWrapper(this.cwin)
					&& Cu.waiveXrays(this.view._iframeWindow) === this.cwin;
			}
			catch (e) {
				return false;
			}
		}

		dispose() {
			this.disposed = true;
			clearTimeout(this.pendingTimer);
			clearTimeout(this.toastTimer);
			clearTimeout(this.welcomeTimer);
			try {
				this.win.removeEventListener('pointerdown', this.onPointerDown, true);
				this.win.removeEventListener('pointerup', this.onPointerUp, true);
				this.observer.disconnect();
				this.overlay?.remove();
				this.toastEl?.remove();
				this.helpEl?.remove();
			}
			catch (e) {
				// The window is already gone
			}
		}

		/**
		 * Run an async action after the ones already queued. Held-down motion
		 * keys can outpace page loads, so those (`repeatable`) are dropped once
		 * a few are waiting; bookmarks and jumps always run.
		 */
		run(fn, { repeatable = false } = {}) {
			if (this.disposed || (repeatable && this.busy > 3)) {
				return this.queue;
			}
			let generation = this.generation;
			this.busy++;
			this.queue = this.queue
				.then(() => {
					if (!this.disposed && generation === this.generation) {
						return fn();
					}
					return undefined;
				})
				.catch(e => Zotero.logError(e))
				.then(() => {
					this.busy--;
				});
			return this.queue;
		}

		focusView() {
			try {
				this.view.focus();
			}
			catch (e) {}
		}

		// ---- keys ----------------------------------------------------------

		/**
		 * Called from ReaderController's capture listener on the reader's
		 * <browser>, which runs before Zotero's own handlers, so a key we take
		 * here (e.g. the h in "mh") never reaches them.
		 */
		onKeyDown(event) {
			if (this.disposed) {
				return;
			}
			try {
				if (MODIFIER_KEYS.has(event.key)) {
					return;
				}
				// A composed letter after a dead key can still name a bookmark
				if (event.isComposing && !(this.pending && letterOf(event))) {
					return;
				}
				// Alt/Option (and Windows AltGr, which reports as Ctrl+Alt) are allowed for
				// symbols, since some keyboard layouts need them for { } '
				let altGraph = event.getModifierState && event.getModifierState('AltGraph');
				if (!altGraph && (event.metaKey || event.ctrlKey
						|| (event.altKey && /^[a-z0-9]$/i.test(event.key)))) {
					this.clearPending();
					return;
				}
				if (isEditable(event.target) || this.textAnnotationFocused()) {
					return;
				}
				if (this.handleKey(keyOf(event), event)) {
					event.preventDefault();
					event.stopPropagation();
				}
			}
			catch (e) {
				Zotero.logError(e);
			}
		}

		textAnnotationFocused() {
			try {
				return !!this.view._textAnnotationFocused();
			}
			catch (e) {
				return false;
			}
		}

		/** Zotero uses digits itself for annotation colours in these states. */
		digitsBelongToZotero() {
			try {
				let state = this.rc.reader._internalReader._state;
				return !!(state.tool && state.tool.color) || !!(state.readAloudState && state.readAloudState.annotationPopup);
			}
			catch (e) {
				return false;
			}
		}

		/** @returns {boolean} whether the key was ours */
		handleKey(key, event = null) {
			if (this.pending) {
				let prefix = this.pending;
				let count = this.pendingCount;
				this.clearPending();
				if (key === 'Escape') {
					return true; // just cancels the prefix
				}
				let letter = /^[a-zA-Z]$/.test(key) ? key : (event && letterOf(event));
				if (prefix === 'm' && letter) {
					this.run(() => this.setMark(letter));
					return true;
				}
				if ((prefix === "'" || prefix === '`') && (letter || /^['`"]$/.test(key))) {
					let name = letter || (key === '`' ? "'" : key);
					this.run(() => this.jumpToMark(name));
					return true;
				}
				if (prefix === 'g' && key === 'g') {
					this.run(() => (count ? this.gotoPage(count - 1) : this.gotoEdge(-1)));
					return true;
				}
				let mode = prefix === 'z' && { z: 'center', '.': 'center', t: 'top', b: 'bottom' }[key];
				if (mode) {
					this.run(() => this.reposition(mode));
					return true;
				}
				// Not a continuation: drop the prefix and treat this as a fresh key
				return this.handleKey(key, event);
			}

			if (/^[0-9]$/.test(key) && (key !== '0' || this.count)) {
				if (!this.count && this.digitsBelongToZotero()) {
					return false;
				}
				// Four digits is plenty (page 9999), and keeps counts from running away
				if (this.count.length < 4) {
					this.count += key;
				}
				this.showHint();
				return true;
			}

			let count = this.count ? parseInt(this.count, 10) : 0;
			this.count = '';
			let motion = fn => {
				this.clearPending();
				this.run(fn, { repeatable: true });
				return true;
			};
			switch (key) {
				case 'j':
					return motion(() => this.move(count || 1));
				case 'k':
					return motion(() => this.move(-(count || 1)));
				case '}':
					return motion(() => this.paragraph(1, count || 1));
				case '{':
					return motion(() => this.paragraph(-1, count || 1));
				case 'H':
				case 'M':
				case 'L':
					return motion(() => this.screenLine(key));
				case 'G':
					this.clearPending();
					this.run(() => (count ? this.gotoPage(count - 1) : this.gotoEdge(1)));
					return true;
				case 'g':
				case 'z':
				case 'm':
				case "'":
				case '`':
					this.pending = key;
					this.pendingCount = count;
					this.showHint();
					return true;
				case '?':
					this.clearPending();
					this.toggleHelp();
					return true;
			}
			// Escape is handled after Zotero has had its turn (see ReaderController)
			if (this.hintShowing) {
				this.clearPending();
			}
			return false;
		}

		showHint() {
			this.hintShowing = true;
			let count = this.pending ? (this.pendingCount || '') : this.count;
			this.toast(`${count}${this.pending || ''}`, 0);
			clearTimeout(this.pendingTimer);
			this.pendingTimer = setTimeout(() => this.clearPending(), PENDING_TIMEOUT);
		}

		clearPending() {
			this.pending = null;
			this.pendingCount = 0;
			this.count = '';
			clearTimeout(this.pendingTimer);
			if (this.hintShowing) {
				this.hintShowing = false;
				this.toast(null);
			}
		}

		// ---- pointer -------------------------------------------------------

		onPointerDown(event) {
			this.down = { x: event.clientX, y: event.clientY };
		}

		onPointerUp(event) {
			let down = this.down;
			this.down = null;
			if (event.target && event.target.closest && event.target.closest('.inchworm-help, .inchworm-toast')) {
				return;
			}
			if (!down || !this.shown || !pref('clickToMove') || event.button !== 0
					|| event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
				return;
			}
			if (Math.abs(event.clientX - down.x) > 4 || Math.abs(event.clientY - down.y) > 4) {
				return; // a drag, e.g. selecting text
			}
			let { clientX, clientY } = event;
			this.run(() => this.moveToPoint(clientX, clientY));
		}

		async moveToPoint(x, y) {
			for (let p of this.visiblePageIndexes()) {
				let pv = this.pageView(p);
				if (!pv) {
					continue;
				}
				let div = Cu.unwaiveXrays(pv.div);
				let pr = div.getBoundingClientRect();
				if (x < pr.left || x > pr.right || y < pr.top || y > pr.bottom) {
					continue;
				}
				let lines = await this.getLines(p);
				if (!lines.length) {
					return;
				}
				let vp = pv.viewport;
				let t = Array.from(vp.transform);
				let sx = div.clientWidth / vp.width || 1;
				let sy = div.clientHeight / vp.height || 1;
				let [px, py] = InchwormLines.viewportPointToPdf(
					(x - pr.left - div.clientLeft) / sx, (y - pr.top - div.clientTop) / sy, t);
				let index = InchwormLines.nearestLineIndex(lines, px, py);
				this.setCursor({ pageIndex: p, lineIndex: index, line: lines[index] }, { scroll: false });
				return;
			}
		}

		// ---- lines ---------------------------------------------------------

		pageCount() {
			try {
				return this.app.pdfViewer.pagesCount || 0;
			}
			catch (e) {
				return 0;
			}
		}

		currentPageIndex() {
			try {
				return Math.max(0, this.app.pdfViewer.currentPageNumber - 1);
			}
			catch (e) {
				return 0;
			}
		}

		pageView(p) {
			try {
				return this.app.pdfViewer.getPageView(p) || null;
			}
			catch (e) {
				return null;
			}
		}

		pageData(p) {
			try {
				let pages = this.view._pdfPages;
				return (pages && pages[p]) || null;
			}
			catch (e) {
				return null;
			}
		}

		pageLabel(p) {
			try {
				let label = this.view._pageLabels && this.view._pageLabels[p];
				if (label) {
					return String(label);
				}
			}
			catch (e) {}
			return String(p + 1);
		}

		/** The lines j/k walk through: raw lines minus headers, footers and page numbers (if enabled). */
		async getLines(p) {
			let raw = await this.rawLines(p);
			if (!pref('skipMargins') || !raw.length) {
				return raw;
			}
			let neighbors = [];
			for (let q = p - 2; q <= p + 2; q++) {
				if (q !== p && q >= 0 && q < this.pageCount()) {
					neighbors.push({ lines: await this.rawLines(q), viewBox: this.cache.get(q)?.viewBox });
				}
			}
			// Reuse the result unless this page or one of its neighbours was re-read
			let cached = this.navCache.get(p);
			if (cached && cached.raw === raw && cached.neighbors.length === neighbors.length
					&& cached.neighbors.every((lines, i) => lines === neighbors[i].lines)) {
				return cached.lines;
			}
			let viewBox = this.cache.get(p)?.viewBox;
			let skip = InchwormLines.findMarginLines(raw, viewBox, neighbors, this.pageLabel(p));
			let lines = InchwormLines.withoutMargins(raw, skip);
			this.navCache.set(p, { raw, neighbors: neighbors.map(n => n.lines), lines });
			return lines;
		}

		/** Every line on the page, straight from the reader's char data. */
		async rawLines(p) {
			let cached = this.cache.get(p);
			let pd = this.pageData(p);
			// The reader swaps in a new chars array when it learns which chars are
			// headers/footers, so rebuild when the source array changes
			if (cached && (!pd || cached.src === pd.chars)) {
				return cached.lines;
			}
			if (!pd) {
				pd = await this.fetchPageData(p);
			}
			let lines;
			if (pd && pd.chars) {
				lines = InchwormLines.linesFromChars(this.importChars(pd.chars));
			}
			else {
				lines = await this.linesFromTextContent(p);
			}
			this.cache.set(p, { src: pd ? pd.chars : null, lines, viewBox: this.viewBox(p, pd) });
			return lines;
		}

		/**
		 * Char data for a page the reader hasn't loaded. Asks the PDF worker
		 * directly rather than through the reader, so pages Inchworm only peeks
		 * at (neighbours, pages skipped over) don't pile up in the reader's memory.
		 */
		async fetchPageData(p) {
			try {
				let doc = this.app.pdfDocument;
				if (doc && typeof doc.getPageData === 'function') {
					return await doc.getPageData(Cu.cloneInto({ pageIndex: p }, this.win));
				}
			}
			catch (e) {}
			try {
				// Newer reader builds
				if (this.view._documentData) {
					await this.view._documentData.ensurePage(p);
					return this.pageData(p);
				}
			}
			catch (e) {}
			return null;
		}

		viewBox(p, pd) {
			try {
				let box = (pd && pd.viewBox) || this.pageView(p)?.viewport.viewBox;
				return box ? Array.from(box) : null;
			}
			catch (e) {
				return null;
			}
		}

		/** Copy the reader's chars into our compartment in one hop (much faster than per-property access). */
		importChars(chars) {
			try {
				return JSON.parse(this.cwin.JSON.stringify(chars, Cu.cloneInto(CHAR_FIELDS, this.cwin)));
			}
			catch (e) {
				let out = [];
				for (let i = 0; i < chars.length; i++) {
					let ch = chars[i];
					let copy = {};
					for (let field of CHAR_FIELDS) {
						let value = ch[field];
						copy[field] = value && typeof value === 'object' ? Array.from(value) : value;
					}
					out.push(copy);
				}
				return out;
			}
		}

		async linesFromTextContent(p) {
			try {
				let page = await this.app.pdfDocument.getPage(p + 1);
				let content = await page.getTextContent();
				return InchwormLines.linesFromTextItems(JSON.parse(this.cwin.JSON.stringify(content.items)));
			}
			catch (e) {
				Zotero.logError(e);
				return [];
			}
		}

		/** First line at or after page p (dir 1), or last line at or before it (dir -1). */
		async findLine(p, dir, limit = 50) {
			let n = this.pageCount();
			for (let i = 0; i < limit && p >= 0 && p < n; i++, p += dir) {
				let lines = await this.getLines(p);
				if (lines.length) {
					let index = dir > 0 ? 0 : lines.length - 1;
					return { pageIndex: p, lineIndex: index, line: lines[index] };
				}
			}
			return null;
		}

		async step(pos, delta) {
			let { pageIndex, lineIndex } = pos;
			let lines = await this.getLines(pageIndex);
			if (!lines.length && delta) {
				// The page lost its lines (e.g. header skipping was just turned on)
				let dir = Math.sign(delta);
				let found = await this.findLine(pageIndex + dir, dir);
				if (!found) {
					return pos;
				}
				({ pageIndex, lineIndex } = found);
				lines = await this.getLines(pageIndex);
				delta -= dir;
			}
			lineIndex = Math.max(0, Math.min(lineIndex, lines.length - 1));
			while (delta > 0) {
				if (lineIndex + 1 < lines.length) {
					lineIndex++;
					delta--;
					continue;
				}
				let next = await this.findLine(pageIndex + 1, 1);
				if (!next) {
					break;
				}
				({ pageIndex, lineIndex } = next);
				lines = await this.getLines(pageIndex);
				delta--;
			}
			while (delta < 0) {
				if (lineIndex > 0) {
					lineIndex--;
					delta++;
					continue;
				}
				let prev = await this.findLine(pageIndex - 1, -1);
				if (!prev) {
					break;
				}
				({ pageIndex, lineIndex } = prev);
				lines = await this.getLines(pageIndex);
				delta++;
			}
			if (!lines[lineIndex]) {
				return pos;
			}
			return { pageIndex, lineIndex, line: lines[lineIndex] };
		}

		/** The cursor, re-pointed at the current line objects if the page was re-read. */
		async currentPos() {
			let c = this.cursor;
			let lines = await this.getLines(c.pageIndex);
			if (lines[c.lineIndex] === c.line) {
				return c;
			}
			if (!lines.length) {
				let pos = (await this.findLine(c.pageIndex, 1, 5)) || (await this.findLine(c.pageIndex, -1, 5));
				if (pos) {
					this.cursor = { pageIndex: pos.pageIndex, lineIndex: pos.lineIndex, line: pos.line };
				}
				return this.cursor;
			}
			let index = InchwormLines.resolveLine(lines, c.line);
			if (index !== -1) {
				this.cursor = { pageIndex: c.pageIndex, lineIndex: index, line: lines[index] };
			}
			return this.cursor;
		}

		// ---- geometry ------------------------------------------------------

		visiblePageIndexes() {
			try {
				let views = this.app.pdfViewer._getVisiblePages().views;
				let out = [];
				for (let i = 0; i < views.length; i++) {
					out.push(views[i].id - 1);
				}
				if (out.length) {
					return out.sort((a, b) => a - b);
				}
			}
			catch (e) {}
			let cr = this.container.getBoundingClientRect();
			let out = [];
			let cur = this.currentPageIndex();
			for (let p = Math.max(0, cur - 3); p < Math.min(this.pageCount(), cur + 4); p++) {
				let pv = this.pageView(p);
				let pr = pv && Cu.unwaiveXrays(pv.div).getBoundingClientRect();
				if (pr && pr.bottom > cr.top && pr.top < cr.bottom) {
					out.push(p);
				}
			}
			return out;
		}

		/** Client (viewport) rect of a PDF rect on page p. */
		clientRect(p, rect) {
			let pv = this.pageView(p);
			if (!pv) {
				return null;
			}
			let div = Cu.unwaiveXrays(pv.div);
			let vp = pv.viewport;
			let r = InchwormLines.pdfRectToViewport(rect, Array.from(vp.transform));
			let pr = div.getBoundingClientRect();
			let sx = div.clientWidth / vp.width || 1;
			let sy = div.clientHeight / vp.height || 1;
			let ox = pr.left + div.clientLeft;
			let oy = pr.top + div.clientTop;
			return { left: ox + r[0] * sx, top: oy + r[1] * sy, right: ox + r[2] * sx, bottom: oy + r[3] * sy };
		}

		isOnScreen(pos) {
			let r = this.clientRect(pos.pageIndex, pos.line.rect);
			if (!r) {
				return false;
			}
			let cr = this.container.getBoundingClientRect();
			let half = (r.bottom - r.top) / 2;
			return r.bottom > cr.top + half && r.top < cr.bottom - half && r.right > cr.left && r.left < cr.right;
		}

		/** Fully visible lines, in reading order, with their client rects. */
		async visibleLines() {
			let cr = this.container.getBoundingClientRect();
			let out = [];
			for (let p of this.visiblePageIndexes()) {
				let lines = await this.getLines(p);
				lines.forEach((line, index) => {
					let r = this.clientRect(p, line.rect);
					if (r && r.top >= cr.top - 1 && r.bottom <= cr.bottom + 1 && r.right > cr.left && r.left < cr.right) {
						out.push({ pageIndex: p, lineIndex: index, line, client: r });
					}
				});
			}
			return out;
		}

		scrollTo(pos, mode) {
			let r = this.clientRect(pos.pageIndex, pos.line.rect);
			if (!r) {
				return;
			}
			let c = this.container;
			let cr = c.getBoundingClientRect();
			let viewH = c.clientHeight;
			let viewW = c.clientWidth;
			let top = r.top - cr.top;
			let bottom = r.bottom - cr.top;
			let left = r.left - cr.left;
			let right = r.right - cr.left;
			let frac = Math.min(50, Math.max(0, parseInt(pref('scrolloff'), 10) || 0)) / 100;
			let margin = Math.min(16, viewH / 10);

			let dy = 0;
			if (mode === 'center' || (mode === 'auto' && frac >= 0.5)) {
				dy = (top + bottom) / 2 - viewH / 2;
			}
			else if (mode === 'top') {
				dy = top - margin;
			}
			else if (mode === 'bottom') {
				dy = bottom - viewH + margin;
			}
			else {
				let off = Math.max(0, Math.min(viewH * frac, (viewH - (bottom - top)) / 2));
				if (top < off) {
					dy = top - off;
				}
				else if (bottom > viewH - off) {
					dy = bottom - (viewH - off);
				}
			}

			// When zoomed in, keep the start of the line in view
			let dx = 0;
			if (left < 0 || right - left > viewW) {
				dx = left - margin;
			}
			else if (right > viewW) {
				dx = right - viewW + margin;
			}

			if (Math.abs(dy) >= 1 || Math.abs(dx) >= 1) {
				c.scrollBy({ top: Math.round(dy), left: Math.round(dx), behavior: 'instant' });
			}
		}

		// ---- cursor --------------------------------------------------------

		setCursor(pos, { scroll = 'auto' } = {}) {
			if (this.disposed || !pos || !pos.line) {
				return;
			}
			this.cursor = { pageIndex: pos.pageIndex, lineIndex: pos.lineIndex, line: pos.line };
			this.shown = true;
			if (scroll) {
				this.scrollTo(this.cursor, scroll);
			}
			this.draw();
			InchwormMarks.set(this.rc.ref, '"', this.markFromPos(this.cursor));
		}

		/**
		 * Make sure a cursor is showing. Returns true when it already was
		 * (so the motion should move it), false when this call placed it.
		 */
		async activate(anchor) {
			if (this.cursor && this.shown && this.isOnScreen(this.cursor)) {
				return true;
			}
			let pos = null;
			if (this.cursor && this.isOnScreen(this.cursor)) {
				pos = await this.currentPos();
			}
			if (!pos && !this.cursor) {
				// First use in this view: resume where the cursor was last time, if that's on screen
				let last = InchwormMarks.get(this.rc.ref, '"');
				if (last) {
					let resumed = await this.resolveMark(last);
					if (resumed && this.isOnScreen(resumed)) {
						pos = resumed;
					}
				}
			}
			if (!pos) {
				let visible = await this.visibleLines();
				if (visible.length) {
					pos = anchor === 'bottom' ? visible[visible.length - 1] : visible[0];
				}
			}
			if (!pos) {
				pos = await this.findLine(this.currentPageIndex(), anchor === 'bottom' ? -1 : 1, 5);
			}
			if (!pos) {
				this.toast('No text found here');
				return false;
			}
			this.setCursor(pos, { scroll: this.isOnScreen(pos) ? false : 'auto' });
			return false;
		}

		async move(delta) {
			if (!(await this.activate(delta > 0 ? 'top' : 'bottom'))) {
				return;
			}
			this.setCursor(await this.step(await this.currentPos(), delta));
		}

		async paragraph(dir, count) {
			if (!(await this.activate(dir > 0 ? 'top' : 'bottom'))) {
				return;
			}
			let same = (a, b) => a.pageIndex === b.pageIndex && a.lineIndex === b.lineIndex;
			let pos = await this.currentPos();
			for (let i = 0; i < count; i++) {
				let start = pos;
				if (dir > 0) {
					// Walk to the first line after the end of this paragraph
					for (let guard = 0; guard < 5000; guard++) {
						let ends = pos.line.paragraphEnd;
						let next = await this.step(pos, 1);
						if (same(next, pos)) {
							break;
						}
						pos = next;
						if (ends) {
							break;
						}
					}
				}
				else {
					// Back to the start of this paragraph, or of the previous one if already there
					let prev = await this.step(pos, -1);
					if (same(prev, pos)) {
						break;
					}
					pos = prev;
					for (let guard = 0; guard < 5000; guard++) {
						let before = await this.step(pos, -1);
						if (same(before, pos) || before.line.paragraphEnd) {
							break;
						}
						pos = before;
					}
				}
				if (same(pos, start)) {
					break; // start or end of the document
				}
			}
			this.setCursor(pos);
		}

		async screenLine(which) {
			let visible = await this.visibleLines();
			if (!visible.length) {
				return;
			}
			let pick = visible[0];
			if (which === 'H') {
				for (let v of visible) {
					if (v.client.top < pick.client.top - 1) {
						pick = v;
					}
				}
			}
			else if (which === 'L') {
				for (let v of visible) {
					if (v.client.bottom > pick.client.bottom + 1) {
						pick = v;
					}
				}
			}
			else {
				let cr = this.container.getBoundingClientRect();
				let mid = (cr.top + cr.bottom) / 2;
				let dist = v => Math.abs((v.client.top + v.client.bottom) / 2 - mid);
				for (let v of visible) {
					if (dist(v) < dist(pick) - 1) {
						pick = v;
					}
				}
			}
			this.setCursor(pick, { scroll: false });
		}

		async gotoEdge(dir) {
			let pos = dir < 0 ? await this.findLine(0, 1) : await this.findLine(this.pageCount() - 1, -1);
			if (pos) {
				await this.recordJump();
				this.setCursor(pos, { scroll: 'center' });
			}
		}

		async gotoPage(pageIndex) {
			let n = this.pageCount();
			let p = Math.max(0, Math.min(pageIndex, n - 1));
			let pos = await this.findLine(p, 1);
			if (!pos) {
				this.toast(`No text on page ${p + 1}`);
				return;
			}
			await this.recordJump();
			this.setCursor(pos, { scroll: 'top' });
		}

		reposition(mode) {
			if (this.cursor && this.shown) {
				this.scrollTo(this.cursor, mode);
			}
		}

		hide() {
			this.generation++;
			this.shown = false;
			this.removeOverlay();
			this.toggleHelp(false);
			this.clearPending();
			this.toast(null);
		}

		// ---- bookmarks -----------------------------------------------------

		markFromPos(pos) {
			return {
				pageIndex: pos.pageIndex,
				rect: pos.line.rect.map(v => Math.round(v * 100) / 100),
				text: pos.line.text.slice(0, 160),
				pageLabel: this.pageLabel(pos.pageIndex),
				time: Date.now(),
			};
		}

		async resolveMark(mark) {
			let n = this.pageCount();
			if (!n || !mark) {
				return null;
			}
			let p = Math.max(0, Math.min(mark.pageIndex | 0, n - 1));
			let lines = await this.getLines(p);
			let index = InchwormLines.resolveLine(lines, mark);
			if (index === -1) {
				return this.findLine(p, 1);
			}
			return { pageIndex: p, lineIndex: index, line: lines[index] };
		}

		async setMark(name) {
			if (!this.cursor || !this.shown || !this.isOnScreen(this.cursor)) {
				await this.activate('top');
			}
			if (!this.cursor) {
				return;
			}
			let mark = this.markFromPos(this.cursor);
			if (InchwormMarks.isGlobal(name)) {
				let item = this.rc.item;
				Object.assign(mark, { libraryID: item.libraryID, itemKey: item.key, title: this.rc.title() });
			}
			InchwormMarks.set(this.rc.ref, name, mark);
			this.toast(`Bookmark ${name} set on p. ${mark.pageLabel}`);
		}

		async jumpToMark(name) {
			let mark = InchwormMarks.get(this.rc.ref, name);
			if (!mark) {
				let message = {
					"'": 'No earlier position to jump back to yet',
					'"': 'No saved position for this paper yet',
				}[name] || `Bookmark ${name} isn't set`;
				this.toast(message);
				return;
			}
			if (InchwormMarks.isGlobal(name) && !this.rc.owns(mark)) {
				let result = await openGlobalMark(name, mark);
				if (result === 'missing') {
					this.toast(`The paper for bookmark ${name} isn't in your library anymore`);
				}
				else if (result === 'timeout') {
					this.toast(`Couldn’t open the paper for bookmark ${name}`);
				}
				return;
			}
			await this.jumpTo(mark);
		}

		async jumpTo(mark, { record = true } = {}) {
			let pos = await this.resolveMark(mark);
			if (!pos) {
				this.toast('Couldn’t find that spot');
				return;
			}
			if (record) {
				await this.recordJump();
			}
			this.setCursor(pos, { scroll: 'center' });
		}

		/** Remember where we are as the `'` mark, so '' can come back. */
		async recordJump() {
			let pos = this.cursor && this.shown && this.isOnScreen(this.cursor)
				? this.cursor
				: (await this.visibleLines())[0];
			if (pos) {
				InchwormMarks.set(this.rc.ref, "'", this.markFromPos(pos));
			}
		}

		// ---- drawing -------------------------------------------------------

		isDark() {
			try {
				if (this.view._themeColorScheme) {
					return this.view._themeColorScheme === 'dark';
				}
			}
			catch (e) {}
			return this.doc.documentElement.dataset.colorScheme === 'dark';
		}

		draw() {
			if (this.disposed) {
				return;
			}
			if (!this.shown || !this.cursor) {
				this.removeOverlay();
				return;
			}
			let pv = this.pageView(this.cursor.pageIndex);
			if (!pv) {
				return;
			}
			let div = Cu.unwaiveXrays(pv.div);
			let el = this.overlay;
			if (!el) {
				el = this.overlay = this.doc.createElement('div');
				el.className = 'inchworm-line';
				el.setAttribute('aria-hidden', 'true');
			}
			// pdf.js empties page divs when it re-renders them, so the overlay
			// lives in the page div and re-attaches itself (see onMutation)
			let reparent = el.parentNode !== div;
			if (reparent) {
				div.append(el);
				this.observer.disconnect();
				this.observer.observe(div, { childList: true });
				this.watched = div;
			}
			let style = pref('style');
			let vp = pv.viewport;
			let rect = InchwormLines.padRect(this.cursor.line.rect, 0.15, style === 'underline' ? 0.02 : 0.08);
			let r = InchwormLines.pdfRectToViewport(rect, Array.from(vp.transform));
			let s = el.style;
			// Percentages keep the box in place while pdf.js zooms with CSS
			s.transition = reparent || !Zotero.Prefs.get(PREF_BRANCH + 'animate', true) ? 'none' : TRANSITION;
			s.left = pct(r[0], vp.width);
			s.top = pct(r[1], vp.height);
			s.width = pct(r[2] - r[0], vp.width);
			s.height = pct(r[3] - r[1], vp.height);
			applyLineStyle(s, style, pref('color'), this.isDark());
		}

		onMutation() {
			if (!this.disposed && this.shown && this.overlay && this.overlay.parentNode !== this.watched) {
				this.draw();
			}
		}

		removeOverlay() {
			this.observer.disconnect();
			this.watched = null;
			this.overlay?.remove();
		}

		// ---- toast & help --------------------------------------------------

		toast(message, ms = 1800) {
			let el = this.toastEl;
			if (!message) {
				if (el) {
					el.style.opacity = '0';
				}
				return;
			}
			if (!el) {
				el = this.toastEl = this.doc.createElement('div');
				el.className = 'inchworm-toast';
				el.setAttribute('role', 'status');
				let s = el.style;
				s.position = 'fixed';
				s.left = '50%';
				s.bottom = '20px';
				s.transform = 'translateX(-50%)';
				s.zIndex = '100000';
				s.pointerEvents = 'none';
				s.padding = '5px 12px';
				s.borderRadius = '6px';
				s.font = '12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
				s.whiteSpace = 'nowrap';
				s.transition = 'opacity 150ms';
				s.opacity = '0';
			}
			let dark = this.isDark();
			el.style.background = dark ? 'rgba(240, 240, 240, 0.92)' : 'rgba(28, 28, 30, 0.88)';
			el.style.color = dark ? '#111' : '#fff';
			el.textContent = message;
			if (!el.isConnected) {
				this.doc.body.append(el);
			}
			el.style.opacity = '1';
			clearTimeout(this.toastTimer);
			if (ms) {
				this.toastTimer = setTimeout(() => {
					el.style.opacity = '0';
				}, ms);
			}
		}

		toggleHelp(force) {
			let open = !!(this.helpEl && this.helpEl.isConnected);
			let show = force === undefined ? !open : force;
			if (!show) {
				this.helpEl?.remove();
				this.helpEl = null;
				return;
			}
			if (open) {
				return;
			}
			let dark = this.isDark();
			let doc = this.doc;
			let el = this.helpEl = doc.createElement('div');
			el.className = 'inchworm-help';
			let s = el.style;
			s.position = 'fixed';
			s.right = '16px';
			s.bottom = '16px';
			s.zIndex = '100001';
			s.maxHeight = 'calc(100% - 32px)';
			s.overflow = 'auto';
			s.padding = '12px 16px';
			s.borderRadius = '10px';
			s.font = '12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
			s.background = dark ? 'rgba(38, 38, 40, 0.97)' : 'rgba(255, 255, 255, 0.98)';
			s.color = dark ? '#eee' : '#222';
			s.boxShadow = '0 6px 24px rgba(0, 0, 0, 0.25)';
			s.border = dark ? '1px solid #444' : '1px solid #ddd';
			let title = doc.createElement('div');
			title.textContent = 'Inchworm';
			title.style.fontWeight = '600';
			title.style.marginBottom = '6px';
			el.append(title);
			let table = doc.createElement('table');
			table.style.borderCollapse = 'collapse';
			for (let [keys, what] of HELP) {
				let row = doc.createElement('tr');
				let k = doc.createElement('td');
				k.textContent = keys;
				k.style.fontFamily = 'ui-monospace, Menlo, monospace';
				k.style.paddingRight = '14px';
				k.style.whiteSpace = 'pre';
				k.style.color = dark ? '#ffd76a' : '#8a5a00';
				let d = doc.createElement('td');
				d.textContent = what;
				row.append(k, d);
				table.append(row);
			}
			el.append(table);
			let foot = doc.createElement('div');
			foot.textContent = 'Click or press ? to close';
			foot.style.marginTop = '6px';
			foot.style.opacity = '0.6';
			el.append(foot);
			el.addEventListener('click', () => this.toggleHelp(false));
			doc.body.append(el);
		}

		/** Snapshot for tests and debugging. */
		state() {
			let overlay = null;
			if (this.overlay && this.overlay.isConnected) {
				let s = this.overlay.style;
				let page = this.overlay.parentNode;
				overlay = {
					page: page && page.getAttribute('data-page-number'),
					left: s.left,
					top: s.top,
					width: s.width,
					height: s.height,
					client: this.overlay.getBoundingClientRect().toJSON(),
				};
			}
			return {
				which: this.which,
				shown: this.shown,
				cursor: this.cursor && {
					pageIndex: this.cursor.pageIndex,
					lineIndex: this.cursor.lineIndex,
					text: this.cursor.line.text,
				},
				overlay,
				scrollTop: this.container.scrollTop,
			};
		}
	}

	/** One reader tab/window; owns a ViewController per PDF view. */
	class ReaderController {
		constructor(reader) {
			this.reader = reader;
			this.views = new Map();
			this.keyTarget = null;
			// Keys from the PDF views and from the reader's toolbar/sidebar all pass
			// through the reader's <browser> element on their way down. Listening
			// there in the capture phase runs before Zotero's own key handlers.
			this.onKeyCapture = (event) => {
				let vc = this.viewForEvent(event);
				if (vc) {
					vc.onKeyDown(event);
				}
			};
			// Escape is left to Zotero first (closing popups, deselecting); if it
			// didn't use it, Escape closes our help, then hides the cursor
			this.onKeyBubble = (event) => {
				if (event.key !== 'Escape' || event.defaultPrevented || isEditable(event.target)) {
					return;
				}
				let vc = this.viewForEvent(event);
				if (!vc) {
					return;
				}
				if (vc.helpEl && vc.helpEl.isConnected) {
					vc.toggleHelp(false);
				}
				else {
					vc.hide();
				}
			};
		}

		get item() {
			return Zotero.Items.get(this.reader.itemID);
		}

		get ref() {
			let item = this.item;
			return item ? `${item.libraryID}/${item.key}` : `id/${this.reader.itemID}`;
		}

		owns(mark) {
			let item = this.item;
			return !!item && mark.libraryID === item.libraryID && mark.itemKey === item.key;
		}

		title() {
			let item = this.item;
			if (!item) {
				return '';
			}
			return (item.parentItem || item).getDisplayTitle();
		}

		sync() {
			let frame = this.reader._iframe;
			if (frame && frame !== this.keyTarget) {
				this.detachKeys();
				frame.addEventListener('keydown', this.onKeyCapture, true);
				frame.addEventListener('keydown', this.onKeyBubble, false);
				this.keyTarget = frame;
			}
			let ir;
			try {
				ir = this.reader._internalReader;
			}
			catch (e) {}
			if (!ir) {
				return;
			}
			for (let which of ['primary', 'secondary']) {
				let view = null;
				try {
					view = ir[`_${which}View`];
				}
				catch (e) {}
				let vc = this.views.get(which);
				if (vc && (!view || !vc.isFor(view))) {
					vc.dispose();
					this.views.delete(which);
					vc = null;
				}
				if (!vc && view && isReadyPdfView(view)) {
					this.views.set(which, new ViewController(this, view, which));
				}
			}
		}

		activeView() {
			let last = null;
			try {
				last = this.reader._internalReader._lastView;
			}
			catch (e) {}
			for (let vc of this.views.values()) {
				if (last && vc.isFor(last)) {
					return vc;
				}
			}
			// The last-used view isn't one of ours, e.g. Zotero 10's Reading Mode:
			// the PDF views are hidden, so don't act on them
			if (last) {
				return null;
			}
			return this.views.get('primary') || this.views.values().next().value || null;
		}

		/** The view a key event belongs to: its own PDF view, or the active one for the reader UI. */
		viewForEvent(event) {
			try {
				let target = event.target;
				let doc = target && (target.nodeType === 9 ? target : (target.ownerDocument || target.document));
				if (!doc) {
					return null;
				}
				doc = Cu.unwaiveXrays(doc);
				for (let vc of this.views.values()) {
					if (vc.doc === doc) {
						return vc;
					}
				}
				let ui = this.reader._iframeWindow;
				if (ui && Cu.unwaiveXrays(ui).document === doc) {
					return this.activeView();
				}
			}
			catch (e) {}
			return null;
		}

		detachKeys() {
			try {
				this.keyTarget?.removeEventListener('keydown', this.onKeyCapture, true);
				this.keyTarget?.removeEventListener('keydown', this.onKeyBubble, false);
			}
			catch (e) {}
			this.keyTarget = null;
		}

		dispose() {
			for (let vc of this.views.values()) {
				vc.dispose();
			}
			this.views.clear();
			this.detachKeys();
		}
	}

	function ensureController(reader) {
		if (!reader) {
			return null;
		}
		try {
			if (reader.type !== 'pdf') {
				return null;
			}
		}
		catch (e) {
			return null;
		}
		let rc = controllers.get(reader);
		if (!rc) {
			rc = new ReaderController(reader);
			controllers.set(reader, rc);
		}
		return rc;
	}

	/** Attach to new readers/views and drop closed ones (views get recreated, e.g. on split view). */
	function tick() {
		try {
			let live = new Set(readers());
			for (let [reader, rc] of controllers) {
				if (!live.has(reader)) {
					rc.dispose();
					controllers.delete(reader);
				}
			}
			for (let reader of live) {
				// One reader failing (e.g. mid-close) shouldn't stop the others
				try {
					let rc = ensureController(reader);
					if (rc) {
						rc.sync();
						injectToolbarButton(reader);
					}
				}
				catch (e) {
					Zotero.logError(e);
				}
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
	}

	/**
	 * Open the paper a global (A–Z) bookmark belongs to and jump there.
	 * @returns {Promise<'ok'|'missing'|'timeout'>}
	 */
	async function openGlobalMark(name, mark) {
		let itemID = Zotero.Items.getIDFromLibraryAndKey(mark.libraryID, mark.itemKey);
		if (!itemID) {
			return 'missing';
		}
		await Zotero.Reader.open(itemID, { pageIndex: mark.pageIndex });
		let reader = await waitFor(() => readers().find(r => r.itemID === itemID && !r._isTabClosed), 20000);
		if (reader) {
			try {
				await reader._initPromise;
			}
			catch (e) {}
		}
		let vc = reader && await waitFor(() => {
			let rc = ensureController(reader);
			if (!rc) {
				return null;
			}
			rc.sync();
			return rc.activeView();
		}, 20000);
		if (!vc) {
			return 'timeout';
		}
		// Let the reader finish restoring its scroll position before we move it
		try {
			await Promise.race([vc.view.initializedPromise, new Promise(resolve => setTimeout(resolve, 5000))]);
		}
		catch (e) {}
		await vc.run(() => vc.jumpTo(mark, { record: false }));
		vc.focusView();
		return 'ok';
	}

	// ---- toolbar button & menu ---------------------------------------------

	function createIcon(doc) {
		const NS = 'http://www.w3.org/2000/svg';
		let svg = doc.createElementNS(NS, 'svg');
		svg.setAttribute('width', '20');
		svg.setAttribute('height', '20');
		svg.setAttribute('viewBox', '0 0 20 20');
		svg.setAttribute('fill', 'none');
		let flag = doc.createElementNS(NS, 'path');
		flag.setAttribute('d', 'M5.5 3.25h9a.75.75 0 0 1 .75.75v12.6l-5.25-3.4-5.25 3.4V4a.75.75 0 0 1 .75-.75z');
		flag.setAttribute('stroke', 'currentColor');
		flag.setAttribute('stroke-width', '1.4');
		flag.setAttribute('stroke-linejoin', 'round');
		let line = doc.createElementNS(NS, 'path');
		line.setAttribute('d', 'M7.75 7.5h4.5');
		line.setAttribute('stroke', 'currentColor');
		line.setAttribute('stroke-width', '1.4');
		line.setAttribute('stroke-linecap', 'round');
		svg.append(flag, line);
		return svg;
	}

	function createToolbarButton(doc, reader) {
		let btn = doc.createElement('button');
		btn.className = 'toolbar-button inchworm-toolbar-button';
		btn.title = 'Inchworm: bookmarks and line cursor';
		btn.setAttribute('aria-label', 'Inchworm bookmarks');
		btn.tabIndex = -1;
		btn.append(createIcon(doc));
		btn.addEventListener('click', (event) => {
			try {
				openMenu(reader, btn, event);
			}
			catch (e) {
				Zotero.logError(e);
			}
		});
		return btn;
	}

	/** For readers that were already open before the plugin started (renderToolbar won't fire for them). */
	function injectToolbarButton(reader) {
		let doc;
		try {
			doc = reader._iframeWindow && Cu.unwaiveXrays(reader._iframeWindow).document;
		}
		catch (e) {}
		if (!doc) {
			return;
		}
		let sections = doc.querySelector('.toolbar .end .custom-sections');
		if (!sections || sections.querySelector('.inchworm-toolbar-button')) {
			return;
		}
		let section = doc.createElement('div');
		section.className = 'section';
		section.append(createToolbarButton(doc, reader));
		sections.append(section);
	}

	function removeToolbarButtons(reader) {
		try {
			let doc = Cu.unwaiveXrays(reader._iframeWindow).document;
			for (let btn of doc.querySelectorAll('.inchworm-toolbar-button')) {
				let section = btn.closest('.section');
				(section && section.childElementCount === 1 ? section : btn).remove();
			}
		}
		catch (e) {}
	}

	function onRenderToolbar(event) {
		try {
			let { reader, doc, append } = event;
			if (!reader || reader.type !== 'pdf') {
				return;
			}
			let rc = ensureController(reader);
			if (rc) {
				rc.sync();
			}
			append(createToolbarButton(Cu.unwaiveXrays(doc), reader));
		}
		catch (e) {
			Zotero.logError(e);
		}
	}

	function openMenu(reader, btn, clickEvent) {
		let rc = ensureController(reader);
		if (!rc) {
			return;
		}
		rc.sync();
		let vc = rc.activeView();
		let ref = rc.ref;
		let win = reader._window;
		let doc = win.document;
		doc.getElementById('inchworm-menu')?.remove();
		let popup = doc.createXULElement('menupopup');
		popup.id = 'inchworm-menu';
		(reader._popupset || doc.querySelector('popupset') || doc.documentElement).append(popup);
		popup.addEventListener('popuphidden', (event) => {
			if (event.target === popup) {
				popup.remove();
			}
		});

		let act = fn => () => {
			if (vc) {
				vc.run(fn).then(() => vc.focusView());
			}
		};
		let add = (parent, label, onCommand, opts = {}) => {
			let item = doc.createXULElement('menuitem');
			item.setAttribute('label', label);
			if (opts.disabled) {
				item.setAttribute('disabled', 'true');
			}
			if (opts.acceltext) {
				item.setAttribute('acceltext', opts.acceltext);
			}
			if (opts.type) {
				item.setAttribute('type', opts.type);
				item.setAttribute('name', opts.name);
				if (opts.checked) {
					item.setAttribute('checked', 'true');
				}
			}
			if (onCommand) {
				item.addEventListener('command', () => {
					try {
						onCommand();
					}
					catch (e) {
						Zotero.logError(e);
					}
				});
			}
			parent.append(item);
			return item;
		};
		let separator = parent => parent.append(doc.createXULElement('menuseparator'));
		let submenu = (parent, label) => {
			let menu = doc.createXULElement('menu');
			menu.setAttribute('label', label);
			let inner = doc.createXULElement('menupopup');
			menu.append(inner);
			parent.append(menu);
			return inner;
		};
		let header = (parent, label) => add(parent, label, null, { disabled: true });

		let marks = InchwormMarks.list(ref);
		let globals = InchwormMarks.listGlobal();
		let free = InchwormMarks.nextFree(ref);

		add(popup, free ? `Bookmark this line as “${free}”` : 'All 26 bookmarks are used',
			act(() => vc.setMark(free)), { disabled: !vc || !free, acceltext: 'm' });
		let last = InchwormMarks.get(ref, '"');
		if (last) {
			add(popup, `Where I left off · p. ${last.pageLabel}`, act(() => vc.jumpToMark('"')),
				{ disabled: !vc, acceltext: '\'"' });
		}

		if (marks.length) {
			separator(popup);
			header(popup, 'This paper');
			for (let [name, mark] of marks) {
				add(popup, `${name}   p. ${mark.pageLabel} · ${truncate(mark.text, 52)}`,
					act(() => vc.jumpToMark(name)), { disabled: !vc, acceltext: `'${name}` });
			}
		}
		if (globals.length) {
			separator(popup);
			header(popup, 'Across papers');
			for (let [name, mark] of globals) {
				add(popup, `${name}   ${truncate(mark.title, 36)} · p. ${mark.pageLabel}`,
					() => (vc && rc.owns(mark) ? act(() => vc.jumpToMark(name))() : openGlobalMark(name, mark)),
					{ acceltext: `'${name}` });
			}
		}
		if (marks.length || globals.length) {
			separator(popup);
			let remove = submenu(popup, 'Remove bookmark');
			for (let [name, mark] of marks.concat(globals)) {
				let where = InchwormMarks.isGlobal(name) ? truncate(mark.title, 30) : truncate(mark.text, 40);
				add(remove, `${name}   p. ${mark.pageLabel} · ${where}`, () => InchwormMarks.remove(ref, name));
			}
			if (marks.length) {
				separator(remove);
				add(remove, 'Remove all in this paper', () => InchwormMarks.clearItem(ref));
			}
		}

		separator(popup);
		let styles = submenu(popup, 'Line style');
		for (let [value, label] of STYLES) {
			add(styles, label, () => setPref('style', value),
				{ type: 'radio', name: 'inchworm-style', checked: pref('style') === value });
		}
		add(popup, 'Keyboard shortcuts', act(() => vc.toggleHelp(true)), { disabled: !vc, acceltext: '?' });

		let x = clickEvent.screenX;
		let y = clickEvent.screenY;
		try {
			let frame = reader._iframe.getBoundingClientRect();
			let rect = btn.getBoundingClientRect();
			let screen = win.windowUtils.toScreenRectInCSSUnits(frame.x + rect.x, frame.y + rect.bottom + 2, 0, 0);
			x = screen.x;
			y = screen.y;
		}
		catch (e) {}
		popup.openPopupAtScreen(x, y, false);
	}

	// ---- lifecycle ---------------------------------------------------------

	function onPrefChange(name) {
		for (let rc of controllers.values()) {
			for (let vc of rc.views.values()) {
				if (name === 'skipMargins') {
					vc.navCache.clear();
				}
				vc.draw();
			}
		}
	}

	async function startup({ id, rootURI: uri }) {
		alive = true;
		pluginID = id;
		rootURI = uri;
		await InchwormMarks.load(PathUtils.join(Zotero.DataDirectory.dir, 'inchworm'));

		Zotero.Reader.registerEventListener('renderToolbar', onRenderToolbar, pluginID);
		for (let name of Object.keys(DEFAULTS)) {
			prefSymbols.push(Zotero.Prefs.registerObserver(PREF_BRANCH + name, () => onPrefChange(name), true));
		}
		Zotero.PreferencePanes.register({
			pluginID,
			id: 'zotero-prefpane-inchworm',
			src: rootURI + 'content/preferences.xhtml',
			label: 'Inchworm',
			image: rootURI + 'content/icons/inchworm.svg',
		});
		tick();
		tickTimer = setInterval(tick, 1000);
	}

	async function shutdown() {
		alive = false;
		clearInterval(tickTimer);
		tickTimer = null;
		for (let symbol of prefSymbols) {
			Zotero.Prefs.unregisterObserver(symbol);
		}
		prefSymbols = [];
		for (let rc of controllers.values()) {
			rc.dispose();
		}
		controllers.clear();
		for (let reader of readers()) {
			removeToolbarButtons(reader);
		}
		await InchwormMarks.flush();
	}

	// ---- debugging (exposed as Zotero.Inchworm, also used by test/e2e) ------

	function controllerFor(itemID) {
		let reader = readers().find(r => r.itemID === itemID && !r._isTabClosed);
		return (reader && controllers.get(reader)) || null;
	}

	/** State of every view of the reader showing `itemID`. */
	function debugState(itemID) {
		let rc = controllerFor(itemID);
		return rc ? Array.from(rc.views.values()).map(vc => vc.state()) : null;
	}

	/** Press keys in the active view of the reader showing `itemID`, waiting for each motion to finish. */
	async function debugPress(itemID, keys) {
		let rc = controllerFor(itemID);
		let vc = rc && rc.activeView();
		if (!vc) {
			throw new Error('Inchworm is not attached to a PDF view for item ' + itemID);
		}
		for (let key of keys) {
			let target = vc.doc.activeElement || vc.doc.body;
			let shiftKey = key.length === 1 && key !== key.toLowerCase();
			target.dispatchEvent(new vc.win.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
			await vc.queue;
		}
		return vc.state();
	}

	/** Lines Inchworm sees on a page (for checking line detection on a real paper). */
	async function debugLines(itemID, pageIndex) {
		let vc = controllerFor(itemID)?.activeView();
		return vc ? (await vc.getLines(pageIndex)).map(l => l.text) : null;
	}

	let api = {
		state: debugState,
		press: debugPress,
		lines: debugLines,
		get marksPath() {
			return InchwormMarks.path;
		},
		flushMarks: () => InchwormMarks.flush(),
	};

	return {
		startup: async (params) => {
			await startup(params);
			Zotero.Inchworm = api;
		},
		shutdown: async () => {
			delete Zotero.Inchworm;
			await shutdown();
		},
	};
})();
