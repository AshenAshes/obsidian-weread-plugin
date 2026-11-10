import { SHA256 } from 'crypto-js';
import type ApiRouter from './api-router';
import type { Metadata } from './models';
import { parseMetadata } from './parser/parseResponse';
import { settingsStore } from './settings';
import { get } from 'svelte/store';

export function isReadingCandidate(finishReading: number, progress: number): boolean {
	return finishReading === 1 || (Number.isFinite(progress) && progress > 0);
}

/** Shared candidate source for sync, bookshelf and settings. No writes to the vault. */
export async function getBookCatalog(
	api: ApiRouter,
	signal?: { cancelled: boolean },
	incremental?: {
		lookup(id: string, revision: string): boolean | undefined;
		checked(id: string, revision: string, included: boolean): void;
	}
): Promise<Metadata[]> {
	if (get(settingsStore).syncScope !== 'reading') {
		return (await api.getNotebooksWithRetry()).map(parseMetadata);
	}
	const shelf = await api.getShelf();
	const notebooks = await api.getReadingNotebooks();
	const notesById = new Map(
		notebooks.map((note: any) => [String(note.bookId ?? note.book?.bookId), note])
	);
	const result: Metadata[] = [];
	for (let i = 0; i < shelf.books.length; i += 4) {
		if (signal?.cancelled) return [];
		const batch = await Promise.all(
			shelf.books.slice(i, i + 4).map(async (book) => {
				const id = String(book.bookId);
				const note = notesById.get(id);
				// Keep the raw timestamps (two edits on the same day are different).
				const comparable =
					incremental &&
					(!note ||
						(Number.isFinite(note.sort) &&
							note.sort > 0 &&
							Number.isSafeInteger(note.noteCount) &&
							Number.isSafeInteger(note.reviewCount)));
				const signature = comparable
					? JSON.stringify([
							id,
							book.readUpdateTime,
							book.updateTime,
							book.finishReading,
							book.title,
							book.author,
							book.cover,
							book.type,
							book.category,
							note
								? [
										note.sort,
										note.noteCount,
										note.reviewCount,
										note.bookmarkCount,
										note.readingProgress,
										note.markedStatus
									]
								: null
						])
					: '';
				const stamped = Number.isFinite(book.readUpdateTime) && book.readUpdateTime > 0;
				let revision = signature && stamped ? SHA256(signature).toString() : '';
				let included = revision ? incremental.lookup(id, revision) : undefined;
				let progress: Metadata['progressResponse'];
				if (included === undefined) {
					progress = await api.getReadingProgress(id);
					if (signature && !revision) {
						// Missing reading timestamp: always query progress, then compare the result.
						revision = SHA256(JSON.stringify([signature, progress.book])).toString();
						included = incremental.lookup(id, revision);
					}
					if (included === undefined) {
						included = isReadingCandidate(book.finishReading, progress.book.progress);
						if (revision) incremental.checked(id, revision, included);
					}
				}
				if (!included) return undefined;
				const meta = parseMetadata({
					book,
					noteCount: note?.noteCount ?? 0,
					reviewCount: note?.reviewCount ?? 0,
					sort: book.readUpdateTime
				});
				meta.finishReading = book.finishReading;
				meta.progressResponse = progress;
				return meta;
			})
		);
		for (const meta of batch) if (meta) result.push(meta);
	}
	return result;
}
