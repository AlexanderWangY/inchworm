// Write the update manifest (updates.json) that Zotero polls for new versions.
// manifest.json's update_url points at this file on the latest GitHub release.
//
// Usage: node scripts/update-manifest.mjs build/inchworm-<version>.xpi build/updates.json
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

let [xpi, out] = process.argv.slice(2);
if (!xpi || !out) {
	console.error('usage: node scripts/update-manifest.mjs <xpi> <out.json>');
	process.exit(2);
}

let manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
let { id, strict_min_version, strict_max_version } = manifest.applications.zotero;
let repo = process.env.GITHUB_REPOSITORY || 'AlexanderWangY/inchworm';
let hash = createHash('sha256').update(readFileSync(xpi)).digest('hex');

let updates = {
	addons: {
		[id]: {
			updates: [{
				version: manifest.version,
				update_link: `https://github.com/${repo}/releases/download/v${manifest.version}/${basename(xpi)}`,
				update_hash: `sha256:${hash}`,
				applications: { zotero: { strict_min_version, strict_max_version } },
			}],
		},
	},
};

writeFileSync(out, JSON.stringify(updates, null, 2) + '\n');
console.log(out);
