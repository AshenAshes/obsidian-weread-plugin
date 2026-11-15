import { SHA256 } from 'crypto-js';
import type { TFile, Vault } from 'obsidian';
import { get } from 'svelte/store';
import type { AnnotationFile } from './models';
import { settingsStore } from './settings';

type Stamp = {
	revision: string;
	checked: number;
	included: boolean;
	path?: string;
	mtime?: number;
	eligibilityOnly?: boolean;
};

/** Optional local optimization. Only a successful sync may publish the next index. */
export class SyncIndex {
	readonly unchanged = new Set<string>();
	private revisions = new Map<string, string>();
	private next = new Map<string, Stamp>();
	private previous = new Map<string, Stamp>();
	private files: Map<string, TFile>;

	private constructor(
		private vault: Vault,
		private path: string,
		private key: string,
		files: AnnotationFile[],
		private ttl: number
	) {
		this.files = new Map(files.map((f) => [String(f.bookId), f.file]));
	}

	static async open(
		vault: Vault,
		dir: string | undefined,
		version: string | undefined,
		files: AnnotationFile[],
		force: boolean
	): Promise<SyncIndex | undefined> {
		const s = get(settingsStore);
		if (!dir || s.syncScope !== 'reading') return;
		const settingsKey = (newline: string) => SHA256(
			JSON.stringify([
				version,
				s.userVid,
				s.wereadApiKey,
				s.cookies.find((c) => c.name === 'wr_vid')?.value,
				s.noteLocation,
				s.activeThemeId,
				s.themes.map((theme) =>
					theme.isBuiltIn
						? { ...theme, template: theme.template.replace(/\r?\n/g, newline) }
						: theme
				),
				s.template,
				s.trimBlocks,
				s.removeParens,
				s.removeParensWhitelist,
				s.convertTags,
				s.filterInlineImages,
				s.showEmptyChapterTitleToggle,
				s.saveReadingInfoToggle,
				s.syncPopularHighlightsToggle,
				s.popularHighlightsCacheTtl,
				s.fileNameType,
				s.subFolderType
			])
		).toString();
		const key = settingsKey('\n');
		const ttl = s.syncPopularHighlightsToggle
			? (s.popularHighlightsCacheTtl ?? 7) * 86400000
			: Infinity;
		const index = new SyncIndex(vault, dir + '/sync-index-v1.json', key, files, ttl);
		if (!force) {
			try {
				if (await vault.adapter.exists(index.path)) {
					const data = JSON.parse(await vault.adapter.read(index.path));
					// Older Windows builds hashed bundled templates with CRLF.
					if (data.key === key || data.key === settingsKey('\r\n'))
						index.previous = new Map(data.books);
				}
			} catch {
				/* A missing or corrupt index must not prevent a full sync. */
			}
		}
		return index;
	}

	lookup(id: string, revision: string): boolean | undefined {
		const entry = this.previous.get(id);
		if (
			!entry ||
			entry.revision !== revision ||
			typeof entry.included !== 'boolean' ||
			!Number.isFinite(entry.checked) ||
			Date.now() < entry.checked
		)
			return;
		if (entry.eligibilityOnly === true && entry.included) {
			// Previously filtered out: eligibility is known, content was never synced.
			this.revisions.set(id, revision);
			return true;
		}
		if (entry.included) {
			const file = this.files.get(id);
			if (
				Date.now() - entry.checked >= this.ttl ||
				!file ||
				file.path !== entry.path ||
				!Number.isFinite(entry.mtime) ||
				file.stat.mtime !== entry.mtime
			)
				return;
			this.unchanged.add(id);
		}
		this.next.set(id, entry);
		return entry.included;
	}

	checked(id: string, revision: string, included: boolean): void {
		if (included) this.revisions.set(id, revision);
		else this.next.set(id, { revision, included, checked: Date.now() });
	}

	excluded(id: string): void {
		const revision = this.revisions.get(id);
		if (revision)
			this.next.set(id, {
				revision,
				included: true,
				eligibilityOnly: true,
				checked: Date.now()
			});
	}

	saved(id: string, path?: string): void {
		const revision = this.revisions.get(id);
		if (!revision || !path) return;
		const file = this.vault.getAbstractFileByPath(path) as TFile | null;
		if (file?.stat)
			this.next.set(id, {
				revision,
				included: true,
				checked: Date.now(),
				path,
				mtime: file.stat.mtime
			});
	}

	async persist(): Promise<void> {
		try {
			await this.vault.adapter.write(
				this.path,
				JSON.stringify({ key: this.key, books: Array.from(this.next) })
			);
		} catch {
			console.warn('[weread] 无法保存增量索引，下次可能重新核对');
		}
	}
}
