import { formatBookTitle } from '../utils/sanitizeTitle';
import { App, Modal, Setting } from 'obsidian';
import type ApiRouter from '../api-router';
import type { CommunityBook } from '../models';
import { settingsStore } from '../settings';
import { get } from 'svelte/store';

export class CommunityBookModal extends Modal {
	private generation = 0;
	constructor(
		app: App,
		private api: ApiRouter,
		private sourceId: string,
		private title: string,
		private onSaved: () => void
	) {
		super(app);
	}
	onClose(): void {
		this.generation++;
		this.contentEl.empty();
	}
	onOpen(): void {
		const el = this.contentEl;
		el.createEl('h2', { text: '关联社区版本' });
		el.createEl('p', {
			text: `原书：${this.title}。关联只影响详情页的热门划线和他人书评，不改变个人笔记、进度或同步文件。`
		});
		const current = get(settingsStore).communityBooks?.[this.sourceId];
		if (current)
			new Setting(el)
				.setName(`当前：${current.title}`)
				.setDesc(this.describe(current))
				.addButton((button) =>
					button.setButtonText('解除关联').onClick(() => {
						settingsStore.actions.setCommunityBook(this.sourceId);
						this.onSaved();
						this.close();
					})
				);
		let keyword = formatBookTitle(this.title, get(settingsStore)).trim();
		const search = new Setting(el).setName('搜索书城版本');
		search.addText((input) =>
			input.setValue(keyword).onChange((value) => {
				keyword = value;
			})
		);
		const status = el.createDiv({ attr: { role: 'status' } });
		const results = el.createDiv();
		search.addButton((button) =>
			button.setButtonText('搜索').onClick(async () => {
				if (!keyword.trim()) {
					status.setText('请输入书名');
					return;
				}
				const generation = ++this.generation;
				results.empty();
				status.setText('正在搜索…');
				button.setDisabled(true);
				try {
					const books = await this.api.searchCommunityBooks(keyword);
					if (generation !== this.generation) return;
					status.setText(
						books.length
							? '点击“关联此版本”即可关联。'
							: '未找到匹配结果，请尝试简短书名。'
					);
					for (const book of books.filter((book) => book.bookId !== this.sourceId)) {
						this.createBookSetting(results, book).addButton((select) =>
							select.setButtonText('关联此版本').onClick(async () => {
								const selection = ++this.generation;
								select.setDisabled(true);
								try {
									const detail = await this.api.getBook(book.bookId);
									if (selection !== this.generation) return;
									if (!detail) throw new Error('无法读取出版信息，请重试');
									const chosen: CommunityBook = {
										bookId: book.bookId,
										cover: detail.cover || book.cover,
										title: detail.title || book.title,
										author: detail.author || book.author,
										translator: (detail as any).translator,
										publisher: detail.publisher || book.publisher,
										isbn: detail.isbn || book.isbn
									};
                                    settingsStore.actions.setCommunityBook(this.sourceId, chosen);
                                    this.onSaved();
                                    this.close();
								} catch (error) {
									if (selection === this.generation)
										status.setText(
											error instanceof Error ? error.message : '读取失败'
										);
								} finally {
									select.setDisabled(false);
								}
							})
						);
					}
				} catch (error) {
					if (generation === this.generation)
						status.setText(error instanceof Error ? error.message : '搜索失败');
				} finally {
					button.setDisabled(false);
				}
			})
		);
	}
	private createBookSetting(container: HTMLElement, book: CommunityBook): Setting {
		const row = new Setting(container).setName(book.title).setDesc(this.describe(book));
		row.settingEl.addClass('weread-community-book');
		if (book.cover) {
			const cover = row.settingEl.createEl('img', {
				cls: 'weread-community-book-cover',
				attr: { src: book.cover, alt: book.title, loading: 'lazy' }
			});
			cover.onerror = () => {
				cover.remove();
			};
			row.settingEl.prepend(cover);
		}
		return row;
	}
	private describe(book: CommunityBook): string {
		return [
			book.author && `作者：${book.author}`,
			book.translator && `译者：${book.translator}`,
			book.publisher && `出版社：${book.publisher}`,
			book.isbn && `ISBN：${book.isbn}`
		]
			.filter(Boolean)
			.join(' · ');
	}
}
