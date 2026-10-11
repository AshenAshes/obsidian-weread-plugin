import { requestUrl, RequestUrlParam } from 'obsidian';
import { settingsStore } from './settings';
import { get } from 'svelte/store';
import type { BookProgressResponse, BookReviewResponse } from './models';

export type ShelfBook = {
	bookId: string;
	title: string;
	author?: string;
	cover?: string;
	finishReading: number;
	readUpdateTime?: number;
	type?: number;
};

class ApiV2Manager {
	private readonly gatewayUrl: string = 'https://i.weread.qq.com/api/agent/gateway';

	private async callAgent<T>(apiName: string, params: Record<string, unknown> = {}): Promise<T | undefined> {
		const settings = get(settingsStore);

		if (!settings.wereadApiKey) {
			console.error('API Key 未配置，请在设置中填写。');
			return undefined;
		}

		const req: RequestUrlParam = {
			url: this.gatewayUrl,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${settings.wereadApiKey}`
			},
			body: JSON.stringify({
				api_name: apiName,
				skill_version: '1.0.5',
				...params
			})
		};

		try {
			const resp = await requestUrl(req);
			if (resp.json?.errcode && resp.json.errcode !== 0) {
				console.error(`Agent API 错误: ${resp.json.errmsg}`);
				return undefined;
			}
			return resp.json as T;
		} catch (e) {
			console.error(`Agent API 调用失败: ${apiName}`, e);
			return undefined;
		}
	}

	async searchCommunityBooks(keyword: string) {
		return this.callAgent<{ results: { books?: { bookInfo?: import('./models').CommunityBook }[] }[] }>('/store/search', { keyword, scope: 10 });
	}

	async getBook(bookId: string) {
		return this.callAgent('/book/info', { bookId });
	}

	async getNotebookHighlights(bookId: string) {
		return this.callAgent('/book/bookmarklist', { bookId });
	}

	async getProgress(bookId: string) {
		return this.callAgent('/book/getprogress', { bookId });
	}

	async getShelf(): Promise<{ books: ShelfBook[] }> {
		const result = await this.callAgent<{ books: ShelfBook[] }>('/shelf/sync');
		if (!Array.isArray(result?.books)) throw new Error('获取完整书架失败，请检查 API Key 后重试');
		if (result.books.some((book) => !book.bookId || !book.title ||
			(book.finishReading !== 0 && book.finishReading !== 1))) {
			throw new Error('书架数据不完整，已停止同步');
		}
		return { books: Array.from(new Map(result.books.map((book) => [String(book.bookId), book])).values()) };
	}

	async getReadingProgress(bookId: string): Promise<BookProgressResponse> {
		const result = await this.callAgent<BookProgressResponse>('/book/getprogress', { bookId });
		if (!result?.book || !Number.isFinite(result.book.progress)) {
			throw new Error(`读取书籍 ${bookId} 的阅读状态失败，已停止同步`);
		}
		return result;
	}

	async getReadingStats(mode: string, baseTime?: number) {
		const params: Record<string, unknown> = { mode };
		if (baseTime !== undefined) params.baseTime = baseTime;
		return this.callAgent('/readdata/detail', params);
	}

	async getChapters(bookId: string) {
		const result = await this.callAgent<{
			bookId: string;
			synckey: number;
			chapterUpdateTime: number;
			chapters: any[];
		}>('/book/chapterinfo', { bookId });

		if (!result) return undefined;

		// V2 返回 { chapters: [] }，转换为 V1 格式 { data: [{ updated: [] }] }
		return {
			data: [{
				bookId: result.bookId,
				chapterUpdateTime: result.chapterUpdateTime,
				updated: result.chapters
			}]
		};
	}

	async getNotebookReviews(bookId: string) {
		const reviews: BookReviewResponse['reviews'] = [];
		const cursors = new Set<number>([0]);
		let synckey = 0;
		while (true) {
			const page = await this.callAgent<BookReviewResponse>('/review/list/mine', {
				bookid: bookId, synckey, count: 100
			});
			if (!Array.isArray(page?.reviews)) throw new Error('书评获取失败，已保留本地内容');
			reviews.push(...page.reviews);
			if (page.hasMore !== 1) return { ...page, reviews, hasMore: 0 };
			synckey = page.synckey;
			if (!Number.isFinite(synckey) || cursors.has(synckey)) {
				throw new Error('书评分页不完整，已保留本地内容');
			}
			cursors.add(synckey);
		}
	}

	async getBestBookmarks(bookId: string, chapterUid = 0) {
		return this.callAgent<{
			synckey: number;
			totalCount: number;
			items: {
				bookId: string;
				bookmarkId: string;
				chapterUid: number;
				range: string;
				markText: string;
				totalCount: number;
			}[];
			chapters: { bookId: string; chapterUid: number; chapterIdx: number; title: string }[];
		}>('/book/bestbookmarks', { bookId, chapterUid });
	}

	async getPublicReviews(bookId: string) {
		return this.callAgent('/review/list', {
			bookId,
			reviewListType: 0,
			count: 30
		});
	}

	async getUserInfo(userVid: string) {
		return this.callAgent('/user/info', { userVid });
	}

	/**
	 * 获取当前 API Key 对应的用户信息
	 * 通过 /_list + /review/list/mine 的 author 字段提取
	 */
	async getCurrentUser(): Promise<Record<string, unknown> | undefined> {
		// 先从书架拿一个 bookId
		const shelf = await this.callAgent<{ books: any[] }>('/_list');
		if (!shelf?.books?.length) {
			console.warn('[weread plugin] getCurrentUser: 书架为空');
			return undefined;
		}

		// 遍历书架中的书，找到有评论的书，从中提取 author 信息
		const booksToTry = shelf.books.slice(0, 10);
		for (const book of booksToTry) {
			const result = await this.callAgent<{
				reviews?: any[];
				totalCount?: number;
			}>('/review/list/mine', { bookid: book.bookId, count: 1 });

			if (result?.reviews?.length) {
				const author = result.reviews[0]?.review?.author;
				if (author?.name) {
					return author;
				}
			}
		}

		console.warn('[weread plugin] getCurrentUser: 前 10 本书均无评论');
		return undefined;
	}

	/**
	 * 校验 API Key 有效性（轻量级调用 /_list）
	 */
	async validateApiKey(): Promise<{ valid: boolean }> {
		const result = await this.callAgent<{ errcode?: number }>('/_list');
		return { valid: result?.errcode === undefined || result?.errcode === 0 };
	}

	/**
	 * 获取笔记本列表（所有有笔记的书，不等于完整书架）
	 * 格式与 V1 /api/user/notebook 兼容
	 * 自动处理分页，每页 300 本
	 */
	async getNotebooks() {
		const PAGE_SIZE = 300;
		let allBooks: any[] = [];
		let lastSort: number | undefined;
		const cursors = new Set<number>();

		do {
			const params: Record<string, unknown> = { count: PAGE_SIZE };
			if (lastSort !== undefined) params.lastSort = lastSort;

			const page = await this.callAgent<{
				books: any[];
				hasMore: number;
			}>('/user/notebooks', params);

			if (!Array.isArray(page?.books)) throw new Error('笔记本列表获取失败，不能使用不完整列表同步');

			allBooks = allBooks.concat(page.books);

			if (page.hasMore !== 1) break;

			// 取本页最后一条的 sort 作为下一页的游标
			const lastBook = page.books[page.books.length - 1];
			lastSort = lastBook?.sort;
			if (!Number.isFinite(lastSort) || cursors.has(lastSort)) {
				throw new Error('笔记本分页游标异常，已停止同步');
			}
			cursors.add(lastSort);
		} while (lastSort !== undefined);

		return { books: Array.from(new Map(allBooks.map((book) => [String(book.bookId ?? book.book?.bookId), book])).values()) };
	}
}

export default ApiV2Manager;
