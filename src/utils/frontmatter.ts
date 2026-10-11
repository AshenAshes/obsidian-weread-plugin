import { parseYaml, stringifyYaml } from 'obsidian';
import type { Notebook } from '../models';
import { formatTimeDuration, formatTimestampToDate } from './dateUtil';
import { settingsStore } from '../settings';
import { get } from 'svelte/store';
import { splitFrontmatter } from './managedSections';

export const frontMatterDocType = 'weread-highlights-reviews';

function parseProperties(yaml?: string): Record<string, unknown> {
	if (!yaml?.trim()) return {};
	const parsed = parseYaml(yaml);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('YAML 属性必须是键值对象，已保留原文件');
	}
	return parsed;
}

/** Merge from the actual current text, never from the asynchronous metadata cache. */
export const buildFrontMatter = (
	markdownContent: string,
	notebook: Notebook,
	existingContent?: string
): string => {
	const generated = splitFrontmatter(markdownContent);
	const previous =
		existingContent === undefined
			? {}
			: parseProperties(splitFrontmatter(existingContent).yaml);
	const properties = { ...parseProperties(generated.yaml), ...previous };
	const meta = notebook.metaData;
	Object.assign(properties, {
		doc_type: frontMatterDocType,
		bookId: meta.bookId,
		title: meta.title,
		isbn: meta.isbn ?? '',
		lastReadDate: meta.lastReadDate,
		reviewCount: meta.reviewCount,
		noteCount: meta.noteCount
	});
	if (get(settingsStore).saveReadingInfoToggle) {
		properties.author = meta.author;
		properties.cover = meta.cover;
		const info = meta.readInfo;
		if (info) {
			const finished =
				meta.finishReading === 1 ||
				(meta.finishReading === undefined && info.finishedDate > 0);
			properties.readingStatus = finished ? '4' : info.readingProgress > 0 ? '2' : '1';
			properties.progress = `${info.readingProgress}%`;
			properties.readingTime = formatTimeDuration(info.readingTime ?? 0);
			for (const key of ['totalReadDay', 'readingDate', 'finishedDate'])
				delete properties[key];
			if (info.totalReadDay !== undefined) properties.totalReadDay = info.totalReadDay;
			if (info.readingBookDate > 0)
				properties.readingDate = formatTimestampToDate(info.readingBookDate);
			if (finished && info.finishedDate > 0)
				properties.finishedDate = formatTimestampToDate(info.finishedDate);
		}
	}
	return `---\n${stringifyYaml(properties)}---\n${generated.body}`;
};
