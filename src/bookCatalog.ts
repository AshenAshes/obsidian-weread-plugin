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
	signal?: { cancelled: boolean }
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
				const progress = await api.getReadingProgress(book.bookId);
				if (!isReadingCandidate(book.finishReading, progress.book.progress))
					return undefined;
				const note = notesById.get(String(book.bookId));
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
