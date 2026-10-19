/*
 * Inchworm — line model.
 *
 * Pure functions with no Zotero or DOM dependencies, so they can be unit-tested
 * in Node (see test/lines.test.js). Coordinates are PDF user space:
 * rect = [x1, y1, x2, y2] with the origin at the bottom-left of the page.
 */
var InchwormLines = (function () {
	'use strict';

	function unionRect(a, b) {
		return [
			Math.min(a[0], b[0]),
			Math.min(a[1], b[1]),
			Math.max(a[2], b[2]),
			Math.max(a[3], b[3]),
		];
	}

	/**
	 * Split the reader's per-page chars into lines.
	 *
	 * Zotero's PDF worker returns chars in reading order (columns already
	 * resolved) and flags the last char of every line with `lineBreakAfter`, so
	 * a line is simply the run of chars up to and including that flag.
	 *
	 * @param {Array<{c: string, rect: number[], inlineRect?: number[],
	 *   lineBreakAfter?: boolean, paragraphBreakAfter?: boolean,
	 *   spaceAfter?: boolean, isolated?: boolean, rotation?: number}>} chars
	 * @param {{skipIsolated?: boolean}} [options] drop lines made only of
	 *   "isolated" chars (running headers, footers, page numbers)
	 */
	function linesFromChars(chars, options = {}) {
		let lines = [];
		let start = 0;
		for (let i = 0; i < chars.length; i++) {
			if (chars[i].lineBreakAfter || i === chars.length - 1) {
				let line = makeLine(chars, start, i);
				if (line) {
					lines.push(line);
				}
				start = i + 1;
			}
		}
		if (options.skipIsolated) {
			// A dropped line can carry the paragraph break for the line before it
			let kept = [];
			for (let line of lines) {
				if (line.isolated) {
					if (line.paragraphEnd && kept.length) {
						kept[kept.length - 1].paragraphEnd = true;
					}
					continue;
				}
				kept.push(line);
			}
			lines = kept;
		}
		return lines;
	}

	function makeLine(chars, start, end) {
		let rect = null;
		let text = '';
		let isolated = true;
		for (let i = start; i <= end; i++) {
			let ch = chars[i];
			let r = ch.inlineRect || ch.rect;
			if (r) {
				rect = rect ? unionRect(rect, r) : [r[0], r[1], r[2], r[3]];
			}
			text += ch.c || '';
			if (ch.spaceAfter && i < end) {
				text += ' ';
			}
			if (!ch.isolated) {
				isolated = false;
			}
		}
		text = text.replace(/\s+/g, ' ').trim();
		if (!rect || !text) {
			return null;
		}
		return {
			rect,
			text,
			isolated,
			paragraphEnd: !!chars[end].paragraphBreakAfter,
			rotation: chars[start].rotation || 0,
		};
	}

	/**
	 * Fallback for when the reader's char data isn't available: build lines
	 * from pdf.js getTextContent() items, which arrive in content-stream order
	 * (usually reading order for papers). Only handles horizontal text.
	 *
	 * @param {Array<{str: string, transform: number[], width: number,
	 *   height: number, hasEOL?: boolean}>} items
	 */
	function linesFromTextItems(items) {
		let lines = [];
		let cur = null;
		let flush = () => {
			if (cur && cur.text.trim()) {
				lines.push(cur);
			}
			cur = null;
		};
		for (let item of items) {
			let str = item.str || '';
			let t = item.transform || [1, 0, 0, 1, 0, 0];
			let size = item.height || Math.hypot(t[2], t[3]) || 10;
			if (!str.trim()) {
				if (item.hasEOL) {
					flush();
				}
				continue;
			}
			let x = t[4];
			let baseline = t[5];
			let rect = [x, baseline - size * 0.25, x + (item.width || 0), baseline + size * 0.85];
			if (cur) {
				let sameBaseline = Math.abs(baseline - cur.baseline) < size * 0.5;
				let gap = rect[0] - cur.rect[2];
				if (!sameBaseline || gap > size * 1.5 || gap < -size) {
					flush();
				}
			}
			if (cur) {
				let gap = rect[0] - cur.rect[2];
				let needsSpace = gap > size * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(str);
				cur.text += (needsSpace ? ' ' : '') + str;
				cur.rect = unionRect(cur.rect, rect);
			}
			else {
				cur = { rect, text: str, baseline, size };
			}
			if (item.hasEOL) {
				flush();
			}
		}
		flush();

		return lines.map((line, i) => {
			let next = lines[i + 1];
			let height = line.rect[3] - line.rect[1];
			// Paragraph ends where the next line is noticeably further down or
			// jumps to another column
			let paragraphEnd = !next
				|| line.rect[1] - next.rect[3] > height * 0.8
				|| next.rect[3] > line.rect[3] + height
				|| Math.abs(next.rect[0] - line.rect[0]) > height * 6;
			return {
				rect: line.rect,
				text: line.text.replace(/\s+/g, ' ').trim(),
				isolated: false,
				paragraphEnd,
				rotation: 0,
			};
		});
	}

	/**
	 * Map a PDF rect to viewport (CSS px) space with a pdf.js viewport
	 * transform [a, b, c, d, e, f]. Returns [left, top, right, bottom].
	 */
	function pdfRectToViewport(rect, t) {
		let [x1, y1, x2, y2] = rect;
		let ax = t[0] * x1 + t[2] * y1 + t[4];
		let ay = t[1] * x1 + t[3] * y1 + t[5];
		let bx = t[0] * x2 + t[2] * y2 + t[4];
		let by = t[1] * x2 + t[3] * y2 + t[5];
		return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
	}

	/** Inverse of the viewport transform: CSS px → PDF point. */
	function viewportPointToPdf(x, y, t) {
		let det = t[0] * t[3] - t[1] * t[2];
		let dx = x - t[4];
		let dy = y - t[5];
		return [(t[3] * dx - t[2] * dy) / det, (-t[1] * dx + t[0] * dy) / det];
	}

	/** Grow a PDF rect by a fraction of its own height (min 0.5pt). */
	function padRect(rect, xFrac, yFrac) {
		let h = Math.abs(rect[3] - rect[1]);
		let px = Math.max(0.5, h * xFrac);
		let py = Math.max(0.5, h * yFrac);
		return [rect[0] - px, rect[1] - py, rect[2] + px, rect[3] + py];
	}

	/** Index of the line closest to a PDF point, favouring vertical closeness. */
	function nearestLineIndex(lines, x, y) {
		let best = -1;
		let bestScore = Infinity;
		lines.forEach((line, i) => {
			let r = line.rect;
			let dx = Math.max(r[0] - x, 0, x - r[2]);
			let dy = Math.max(r[1] - y, 0, y - r[3]);
			let score = dy * 2 + dx;
			if (score < bestScore) {
				bestScore = score;
				best = i;
			}
		});
		return best;
	}

	function centerDistance(a, b) {
		return Math.hypot((a[0] + a[2]) / 2 - (b[0] + b[2]) / 2, (a[1] + a[3]) / 2 - (b[1] + b[3]) / 2);
	}

	/**
	 * Find the line a saved position refers to. Line splitting can shift a
	 * little between Zotero versions, so prefer a line with the same text near
	 * the saved rect, else the line whose centre is closest.
	 *
	 * @param {Array} lines
	 * @param {{rect: number[], text?: string}} target
	 * @returns {number} index, or -1 when there are no lines
	 */
	function resolveLine(lines, target) {
		if (!lines.length) {
			return -1;
		}
		let best = -1;
		let bestDist = Infinity;
		if (target.text) {
			lines.forEach((line, i) => {
				if (line.text === target.text) {
					let d = centerDistance(line.rect, target.rect);
					if (d < bestDist) {
						bestDist = d;
						best = i;
					}
				}
			});
			// Same text but far away is probably a repeated line elsewhere
			let h = Math.abs(target.rect[3] - target.rect[1]) || 10;
			if (best !== -1 && bestDist < h * 20) {
				return best;
			}
		}
		best = 0;
		bestDist = Infinity;
		lines.forEach((line, i) => {
			let d = centerDistance(line.rect, target.rect);
			if (d < bestDist) {
				bestDist = d;
				best = i;
			}
		});
		return best;
	}

	const MARGIN_BAND = 0.08;
	const ROMAN = /^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i;

	/** "12", "xii", "Page 3 of 9", "- 4 -" … but not words like "mild" or "Mix". */
	function isPageNumber(text, pageLabel) {
		let t = text.replace(/^[\s\-–—([]+|[\s\-–—)\]]+$/g, '')
			.replace(/^page\s*/i, '')
			.replace(/\s*(of|\/)\s*\d{1,4}$/i, '')
			.trim();
		if (!t) {
			return false;
		}
		if ((pageLabel && t === pageLabel) || /^\d{1,4}$/.test(t)) {
			return true;
		}
		return ROMAN.test(t) && (t === t.toLowerCase() || t === t.toUpperCase());
	}

	function editDistance(a, b) {
		let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
		for (let i = 1; i <= a.length; i++) {
			let cur = [i];
			for (let j = 1; j <= b.length; j++) {
				cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
			}
			prev = cur;
		}
		return prev[b.length];
	}

	// Running heads often carry the page number ("4  Smith et al."), so ignore digits
	function normalizeMarginText(text) {
		return text.toLowerCase().replace(/[0-9]+/g, '#').replace(/\s+/g, ' ').trim();
	}

	function similarText(a, b) {
		if (a === b) {
			return true;
		}
		let max = Math.max(a.length, b.length);
		let min = Math.min(a.length, b.length);
		if (!max || (max - min) / max > 0.2) {
			return false;
		}
		return editDistance(a, b) / max <= 0.2;
	}

	let centerY = rect => (rect[1] + rect[3]) / 2;
	let heightOf = rect => Math.max(1, rect[3] - rect[1]);

	/**
	 * Is `line` cut off from the body text by a clear gap? Walks from the line
	 * towards the middle of the page; other lines in the margin band (a second
	 * header line, say) may come first, but somewhere before the body starts
	 * there must be a gap of at least 1.2 line heights. This keeps the first
	 * and last lines of a column, table rows and reference entries.
	 */
	function separatedFromBody(line, lines, zone, inZone) {
		let towardBody = lines.filter(other => other !== line
			&& Math.abs(centerY(other.rect) - centerY(line.rect)) >= heightOf(line.rect) / 2
			&& (zone === 'top' ? centerY(other.rect) < centerY(line.rect) : centerY(other.rect) > centerY(line.rect)));
		towardBody.sort((a, b) => (zone === 'top' ? b.rect[3] - a.rect[3] : a.rect[1] - b.rect[1]));
		let cur = line;
		for (let next of towardBody) {
			let gap = zone === 'top' ? cur.rect[1] - next.rect[3] : next.rect[1] - cur.rect[3];
			if (gap >= heightOf(cur.rect) * 1.2) {
				return true;
			}
			if (!inZone(next)) {
				return false;
			}
			if (zone === 'top' ? next.rect[1] < cur.rect[1] : next.rect[3] > cur.rect[3]) {
				cur = next;
			}
		}
		return true;
	}

	function aligned(a, b, tolerance) {
		return Math.abs(a[0] - b[0]) <= tolerance
			|| Math.abs(a[2] - b[2]) <= tolerance
			|| Math.abs((a[0] + a[2]) / 2 - (b[0] + b[2]) / 2) <= tolerance;
	}

	/**
	 * Find running headers, footers and page numbers. A line qualifies if it
	 * sits in the top or bottom band of the page, is separated from the body
	 * text by a gap, and either is a page number or repeats (same edge
	 * distance, same alignment, near-identical text) on a page up to two away,
	 * which also covers alternating odd/even running heads. Same idea as
	 * Zotero's own content-area detection, which the reader only runs for
	 * some pages.
	 *
	 * @param {Array<{rect: number[], text: string}>} lines this page's lines
	 * @param {number[]} viewBox the page's [x1, y1, x2, y2]
	 * @param {Array<{lines: Array, viewBox?: number[]}>} neighbors nearby pages
	 * @param {string} [pageLabel]
	 * @returns {Set<number>} indexes into `lines`
	 */
	function findMarginLines(lines, viewBox, neighbors, pageLabel) {
		let margin = new Set();
		if (!viewBox) {
			return margin;
		}
		let zone = (rect, vb) => {
			let band = (vb[3] - vb[1]) * MARGIN_BAND;
			let cy = centerY(rect);
			if (cy > vb[3] - band) {
				return 'top';
			}
			if (cy < vb[1] + band) {
				return 'bottom';
			}
			return null;
		};
		// Distance from the page edge the line sits on
		let edgeOffset = (rect, vb, z) => (z === 'top' ? vb[3] - centerY(rect) : centerY(rect) - vb[1]);

		lines.forEach((line, i) => {
			let z = zone(line.rect, viewBox);
			if (!z || !separatedFromBody(line, lines, z, other => zone(other.rect, viewBox) === z)) {
				return;
			}
			let text = line.text.replace(/\s+/g, ' ').trim();
			if (isPageNumber(text, pageLabel)) {
				margin.add(i);
				return;
			}
			let norm = normalizeMarginText(text);
			// Too little text left to tell a running head from anything else
			if ((norm.match(/[a-z]/g) || []).length < 4) {
				return;
			}
			let offset = edgeOffset(line.rect, viewBox, z);
			let height = heightOf(line.rect);
			let tolerance = Math.max(6, height * 2);
			for (let neighbor of neighbors) {
				let vb = (neighbor && neighbor.viewBox) || viewBox;
				for (let other of (neighbor && neighbor.lines) || []) {
					if (zone(other.rect, vb) !== z
							|| Math.abs(edgeOffset(other.rect, vb, z) - offset) > height
							|| !aligned(line.rect, other.rect, tolerance)) {
						continue;
					}
					if (similarText(norm, normalizeMarginText(other.text))) {
						margin.add(i);
						return;
					}
				}
			}
		});
		return margin;
	}

	/** Drop margin lines, moving a paragraph break they carried onto the previous kept line. */
	function withoutMargins(lines, skip) {
		let kept = [];
		lines.forEach((line, i) => {
			if (line.isolated || skip.has(i)) {
				if (line.paragraphEnd && kept.length) {
					kept[kept.length - 1] = Object.assign({}, kept[kept.length - 1], { paragraphEnd: true });
				}
				return;
			}
			kept.push(line);
		});
		return kept;
	}

	return {
		linesFromChars,
		linesFromTextItems,
		findMarginLines,
		withoutMargins,
		pdfRectToViewport,
		viewportPointToPdf,
		padRect,
		nearestLineIndex,
		resolveLine,
	};
})();

if (typeof module === 'object' && module.exports) {
	module.exports = InchwormLines;
}
