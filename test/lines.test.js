// Run with: node --test test/*.test.js  (or npm test)
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/lines.js');

// Build chars for a line of text the way Zotero's PDF worker shapes them
function lineChars(text, x, y, { size = 10, paragraphEnd = false, isolated = false } = {}) {
	let chars = [];
	let cx = x;
	let words = text.split(' ');
	words.forEach((word, w) => {
		for (let i = 0; i < word.length; i++) {
			let rect = [cx, y, cx + size * 0.5, y + size];
			chars.push({
				c: word[i],
				rect,
				inlineRect: [cx, y - 1, cx + size * 0.5, y + size + 1],
				spaceAfter: i === word.length - 1 && w < words.length - 1,
				isolated,
			});
			cx += size * 0.5;
		}
		cx += size * 0.3;
	});
	let last = chars[chars.length - 1];
	last.lineBreakAfter = true;
	last.paragraphBreakAfter = paragraphEnd;
	return chars;
}

test('splits chars into lines on lineBreakAfter', () => {
	let chars = [
		...lineChars('Attention is all', 72, 700),
		...lineChars('you need.', 72, 688, { paragraphEnd: true }),
		...lineChars('Second paragraph', 72, 670),
	];
	let lines = L.linesFromChars(chars);
	assert.equal(lines.length, 3);
	assert.deepEqual(lines.map(l => l.text), ['Attention is all', 'you need.', 'Second paragraph']);
	assert.equal(lines[1].paragraphEnd, true);
	assert.equal(lines[0].paragraphEnd, false);
	// rect is the union of inlineRects
	assert.equal(lines[0].rect[0], 72);
	assert.equal(lines[0].rect[1], 699);
	assert.equal(lines[0].rect[3], 711);
});

test('keeps reading order across columns', () => {
	// Left column then right column, as the worker emits them
	let chars = [
		...lineChars('left one', 50, 700),
		...lineChars('left two', 50, 688),
		...lineChars('right one', 320, 700),
		...lineChars('right two', 320, 688),
	];
	let lines = L.linesFromChars(chars);
	assert.deepEqual(lines.map(l => l.text), ['left one', 'left two', 'right one', 'right two']);
});

test('skipIsolated drops headers and page numbers but keeps paragraph breaks', () => {
	let chars = [
		...lineChars('Running Head', 72, 760, { isolated: true }),
		...lineChars('Body text', 72, 700),
		...lineChars('ends here', 72, 688),
		...lineChars('7', 300, 40, { isolated: true, paragraphEnd: true }),
	];
	let all = L.linesFromChars(chars);
	assert.equal(all.length, 4);
	let body = L.linesFromChars(chars, { skipIsolated: true });
	assert.deepEqual(body.map(l => l.text), ['Body text', 'ends here']);
	assert.equal(body[1].paragraphEnd, true);
});

test('ignores whitespace-only lines', () => {
	let chars = [...lineChars('real', 72, 700), { c: ' ', rect: [72, 680, 75, 690], lineBreakAfter: true }];
	assert.equal(L.linesFromChars(chars).length, 1);
});

test('text-content fallback groups items into lines', () => {
	let item = (str, x, y, hasEOL = false) => ({ str, transform: [10, 0, 0, 10, x, y], width: str.length * 5, height: 10, hasEOL });
	let lines = L.linesFromTextItems([
		item('Hello', 72, 700), item('world', 102, 700, true),
		item('next line', 72, 688, true),
		item('', 0, 0, true),
		item('New para', 72, 650, true),
	]);
	assert.deepEqual(lines.map(l => l.text), ['Hello world', 'next line', 'New para']);
	assert.equal(lines[1].paragraphEnd, true);
	assert.equal(lines[0].paragraphEnd, false);
});

test('viewport transform round-trips', () => {
	// pdf.js viewport for a 612x792 page at scale 1.5, no rotation
	let t = [1.5, 0, 0, -1.5, 0, 792 * 1.5];
	let r = L.pdfRectToViewport([72, 700, 300, 712], t);
	assert.deepEqual(r, [108, (792 - 712) * 1.5, 450, (792 - 700) * 1.5]);
	let [x, y] = L.viewportPointToPdf(108, (792 - 712) * 1.5, t);
	assert.ok(Math.abs(x - 72) < 1e-9 && Math.abs(y - 712) < 1e-9);

	// Rotated 90°: still returns a normalized box
	let rot = [0, 1.5, 1.5, 0, 0, 0];
	let rr = L.pdfRectToViewport([72, 700, 300, 712], rot);
	assert.ok(rr[0] < rr[2] && rr[1] < rr[3]);
	let [rx, ry] = L.viewportPointToPdf(rr[0], rr[1], rot);
	assert.ok(Math.abs(rx - 72) < 1e-9 && Math.abs(ry - 700) < 1e-9);
});

test('nearestLineIndex prefers the vertically closest line', () => {
	let lines = [
		{ rect: [50, 700, 280, 710] },
		{ rect: [50, 688, 280, 698] },
		{ rect: [320, 700, 550, 710] },
	];
	assert.equal(L.nearestLineIndex(lines, 100, 705), 0);
	assert.equal(L.nearestLineIndex(lines, 100, 690), 1);
	assert.equal(L.nearestLineIndex(lines, 400, 703), 2);
	// In the gap between two lines: the closer one wins
	assert.equal(L.nearestLineIndex(lines, 100, 698.5), 1);
	assert.equal(L.nearestLineIndex(lines, 100, 699.5), 0);
	assert.equal(L.nearestLineIndex([], 0, 0), -1);
});

test('resolveLine finds a saved position by text, then by distance', () => {
	let lines = [
		{ rect: [50, 700, 280, 710], text: 'alpha' },
		{ rect: [50, 688, 280, 698], text: 'beta' },
		{ rect: [50, 676, 280, 686], text: 'gamma' },
	];
	// Text match wins even if the rect drifted a bit
	assert.equal(L.resolveLine(lines, { rect: [50, 684, 280, 694], text: 'gamma' }), 2);
	// Unknown text: nearest centre
	assert.equal(L.resolveLine(lines, { rect: [50, 689, 280, 699], text: 'zzz' }), 1);
	// No text at all
	assert.equal(L.resolveLine(lines, { rect: [50, 701, 280, 711] }), 0);
	assert.equal(L.resolveLine([], { rect: [0, 0, 1, 1] }), -1);
});

test('padRect grows by a fraction of the height', () => {
	assert.deepEqual(L.padRect([10, 10, 110, 20], 0.1, 0.2), [9, 8, 111, 22]);
	// minimum half point
	assert.deepEqual(L.padRect([10, 10, 110, 11], 0.1, 0.1), [9.5, 9.5, 110.5, 11.5]);
});

test('findMarginLines spots running heads, footers and page numbers', () => {
	let viewBox = [0, 0, 612, 792];
	let words = ['alpha', 'bravo', 'charlie', 'delta'];
	let page = (n, head) => [
		{ rect: [54, 756, 300, 764], text: head },
		{ rect: [150, 728, 460, 746], text: ['Reading Line by Line', '2 Related Work', 'Table 3: Results on held-out papers', '4.2 Ablations'][n - 1] },
		{ rect: [54, 700, 290, 710], text: `The ${words[n - 1]} experiment began early` },
		{ rect: [54, 92, 290, 102], text: `and ended with ${words[n - 1]} results` },
		{ rect: [300, 36, 312, 46], text: String(n) },
	];
	// Odd and even pages carry different running heads
	let p1 = page(1, 'Smith et al.');
	let p2 = page(2, 'Reading Line by Line');
	let p3 = page(3, 'Smith et al.');
	let p4 = page(4, 'Reading Line by Line');
	let neighbors = [p1, p2, p4].map(lines => ({ lines, viewBox }));
	let skip = L.findMarginLines(p3, viewBox, neighbors, '3');
	assert.deepEqual([...skip].sort(), [0, 4]);

	// A running head that includes the page number still matches
	let a = [{ rect: [54, 756, 300, 764], text: '4 Journal of Tests, Vol. 2' }];
	let b = [{ rect: [54, 756, 300, 764], text: '6 Journal of Tests, Vol. 2' }];
	assert.deepEqual([...L.findMarginLines(a, viewBox, [{ lines: b, viewBox }])], [0]);

	// Body text near the top that doesn't repeat stays
	assert.equal(L.findMarginLines([p1[1]], viewBox, [{ lines: p2, viewBox }]).size, 0);
	// Roman numerals and "Page 3 of 9"
	let numbers = [
		{ rect: [300, 36, 312, 46], text: 'xii' },
		{ rect: [280, 36, 340, 46], text: 'Page 3 of 9' },
	];
	assert.equal(L.findMarginLines(numbers, viewBox, []).size, 2);
	// No viewBox: nothing is skipped
	assert.equal(L.findMarginLines(p3, null, neighbors).size, 0);
});

test('withoutMargins drops lines and keeps paragraph breaks', () => {
	let lines = [
		{ text: 'head', paragraphEnd: true },
		{ text: 'a', paragraphEnd: false },
		{ text: 'b', paragraphEnd: false },
		{ text: '7', paragraphEnd: true },
		{ text: 'zotero-isolated', isolated: true, paragraphEnd: false },
	];
	let kept = L.withoutMargins(lines, new Set([0, 3]));
	assert.deepEqual(kept.map(l => l.text), ['a', 'b']);
	assert.equal(kept[1].paragraphEnd, true);
	// the input isn't mutated
	assert.equal(lines[2].paragraphEnd, false);
});

// Tight two-column page (0.75in margins): the first/last lines of each column
// fall inside the margin band, so they must not be mistaken for headers
function tightPage(top, bottom) {
	let lines = [];
	let y = 730;
	for (let text of top) {
		lines.push({ rect: [54, y, 290, y + 9], text });
		y -= 11;
	}
	lines.push({ rect: [54, 400, 290, 409], text: 'Some ordinary body text in the middle of the column' });
	y = 54 + 11 * (bottom.length - 1);
	for (let text of bottom) {
		lines.push({ rect: [54, y, 290, y + 9], text });
		y -= 11;
	}
	return lines;
}

test('findMarginLines keeps column-top references, table rows and short words', () => {
	let viewBox = [0, 0, 612, 792];
	let p1 = tightPage(
		['arXiv preprint arXiv:2005.14165, 2020.', '[12] A. Author. Language models are few-shot learners.'],
		['ResNet-50 76.1 92.9 25.6', 'mild']);
	let p2 = tightPage(
		['arXiv preprint arXiv:2103.00020, 2021.', '[31] B. Author. Learning transferable visual models.'],
		['ResNet-101 77.4 93.5 44.5', 'vivid']);
	let skip = L.findMarginLines(p1, viewBox, [{ lines: p2, viewBox }]);
	assert.deepEqual([...skip], []);
});

test('findMarginLines handles stacked and split headers', () => {
	let viewBox = [0, 0, 612, 792];
	let page = n => [
		// two-line running head
		{ rect: [54, 770, 300, 778], text: 'Journal of Reading Research' },
		{ rect: [54, 760, 300, 768], text: `Vol. 12, No. ${n}` },
		// split footer: title on the left, page number on the right
		{ rect: [54, 30, 250, 38], text: 'Preprint under review' },
		{ rect: [540, 30, 558, 38], text: String(n) },
		{ rect: [54, 720, 290, 730], text: `Body line on page ${n} about ${['cats', 'dogs', 'owls'][n - 1]}` },
		{ rect: [54, 708, 290, 718], text: 'more body text follows here' },
		{ rect: [54, 80, 290, 90], text: 'the end of the body text' },
	];
	let skip = L.findMarginLines(page(2), viewBox, [{ lines: page(1), viewBox }, { lines: page(3), viewBox }]);
	assert.deepEqual([...skip].sort(), [0, 1, 2, 3]);
});

test('isPageNumber-style lines: numerals only, not words', () => {
	let viewBox = [0, 0, 612, 792];
	let one = text => [{ rect: [290, 30, 320, 38], text }, { rect: [54, 300, 290, 310], text: 'body' }];
	for (let text of ['7', 'xii', 'XIV', 'Page 3 of 9', '- 4 -', '[5]']) {
		assert.equal(L.findMarginLines(one(text), viewBox, []).size, 1, text);
	}
	for (let text of ['mild', 'Mix', 'civil', 'dim', 'vivid', 'Results']) {
		assert.equal(L.findMarginLines(one(text), viewBox, []).size, 0, text);
	}
});
