// Run: npm test; one case: node --test --test-name-pattern="atomic" scripts/sync-regression.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const yaml = require('js-yaml');
const root = path.resolve(__dirname, '..');

function harness() {
	const cache = new Map();
	const requests = [];
	const queue = [];
	const obsidian = {
		ItemView: class {},
		Modal: class {},
		Platform: { isDesktopApp: true },
		Notice: class {
			hide() {}
			setMessage() {}
		},
		TFile: class {},
		TFolder: class {},
		parseYaml: yaml.load,
		stringifyYaml: (value) => yaml.dump(value),
		requestUrl: async (request) => {
			requests.push(JSON.parse(request.body));
			if (!queue.length) throw new Error('No mock response');
			return { json: queue.shift() };
		}
	};
	const context = vm.createContext({
        btoa,
		console: { log() {}, debug() {}, warn() {}, error() {} },
		window: {
			moment: (time = Date.now()) => ({
				format: () => new Date(time).toISOString().slice(0, 10)
			})
		},
		setTimeout: () => 0,
		clearTimeout,
		document: { createDocumentFragment: () => element() }
	});
	vm.runInContext('Array.prototype.first = function () { return this[0]; };', context);
	function element() {
		return { createDiv: element, setText() {}, style: {} };
	}
	function load(filename) {
		filename = path.resolve(root, filename);
		if (!path.extname(filename)) filename += '.ts';
		if (cache.has(filename)) return cache.get(filename).exports;
		if (filename.endsWith('.njk') || filename.endsWith('.html'))
			return fs.readFileSync(filename, 'utf8');
		const module = { exports: {} };
		cache.set(filename, module);
		const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
			compilerOptions: {
				target: ts.ScriptTarget.ES2021,
				module: ts.ModuleKind.CommonJS,
				esModuleInterop: true
			}
		}).outputText;
		const localRequire = (id) =>
			id === 'obsidian'
				? obsidian
				: id.startsWith('.')
					? load(path.resolve(path.dirname(filename), id))
					: require(id);
		vm.runInContext(`(function(require,module,exports){${source}\n})`, context, { filename })(
			localRequire,
			module,
			module.exports
		);
		return module.exports;
	}
	return { load, queue, requests };
}

const legacy =
	'# 元数据\nold metadata\n\n# 高亮划线\nold highlights\n\n# 读书笔记\n我的原文\n## 我的分析\n\n# 本书评论\nold review\n';
const fresh =
	'# 元数据\nnew metadata\n\n# 高亮划线\nnew highlights\n\n# 读书笔记\nREMOTE NOTES MUST NOT APPEAR\n\n# 本书评论\nnew review\n';

test('legacy migration preserves local notes verbatim and repeated sync is stable', () => {
	const { load } = harness();
	const { mergeManagedSections } = load('src/utils/managedSections.ts');
	const merged = mergeManagedSections(legacy, fresh);
	assert.ok(merged.includes('# 读书笔记\n我的原文\n## 我的分析\n\n'));
	assert.ok(merged.includes('new highlights'));
	assert.ok(!merged.includes('REMOTE NOTES MUST NOT APPEAR'));
	assert.equal(mergeManagedSections(merged, fresh), merged);
});

test('local subheadings and fenced first-level headings remain untouched', () => {
 const { mergeManagedSections } = harness().load('src/utils/managedSections.ts');
 const local = '# 读书笔记\n## 本书评论\n```md\n# 本书评论\n```\n';
 const existing = '前言\n' + legacy.replace('# 读书笔记\n我的原文\n## 我的分析\n\n', local);
 const merged = mergeManagedSections(existing, fresh);
 assert.ok(merged.includes(local));
 assert.ok(merged.startsWith('前言\n'));
 assert.ok(!merged.includes('<!-- weread:'));
});

test('CRLF local note bytes survive migration and later updates', () => {
	const { load } = harness();
	const { mergeManagedSections } = load('src/utils/managedSections.ts');
	const note = '# 读书笔记\r\n我的原文\r\n## 我的分析\r\n\r\n';
	const migrated = mergeManagedSections(legacy.replaceAll('\n', '\r\n'), fresh);
	assert.ok(migrated.includes(note));
	assert.ok(mergeManagedSections(migrated, fresh).includes(note));
});

test('missing, duplicate, reordered and extra first-level headings fail closed', () => {
 const { mergeManagedSections } = harness().load('src/utils/managedSections.ts');
 for (const invalid of [
  legacy.replace('# 读书笔记', '## 读书笔记'),
  legacy.replace('我的原文', '# 本书评论'),
  legacy.replace('我的原文', '# 自写一级标题'),
  legacy.replace('# 元数据', '# 高亮划线').replace('# 高亮划线\nold highlights', '# 元数据\nold highlights')
 ]) assert.throws(() => mergeManagedSections(invalid, fresh));
 assert.throws(() => mergeManagedSections(legacy, '# 不兼容模板'));
});

test('new notes never contain remotely generated personal-note sections', () => {
	const { load } = harness();
	const { prepareNotebookBody } = load('src/utils/managedSections.ts');
	assert.ok(!prepareNotebookBody(fresh, true).includes('REMOTE NOTES'));
	assert.ok(!prepareNotebookBody(prepareNotebookBody(fresh), true).includes('REMOTE NOTES'));
});

test('catalog selects finished or positive progress, independent of isStartReading and timestamps', async () => {
	const { load } = harness();
	const { getBookCatalog } = load('src/bookCatalog.ts');
	const ids = ['done', 'reading', 'brief', 'zero'];
	const api = {
		getShelf: async () => ({
			books: ids.map((id, i) => ({
				bookId: id,
				title: id,
				finishReading: i === 0 ? 1 : 0,
				readUpdateTime: 123
			}))
		}),
		getReadingNotebooks: async () => [],
		getReadingProgress: async (id) => ({
			book: { progress: id === 'reading' ? 42 : 0, isStartReading: 0, readingTime: 100 }
		})
	};
	const result = await getBookCatalog(api);
	assert.equal(result.map((book) => book.bookId).join(','), 'done,reading');
	assert.equal(result[0].noteCount, 0);
	await assert.rejects(() =>
		getBookCatalog({
			...api,
			getReadingProgress: async () => {
				throw new Error('unavailable');
			}
		})
	);
	assert.equal((await getBookCatalog(api, { cancelled: true })).length, 0);
});

test('reading scope ignores note count but still honors black and white lists', () => {
	const { load } = harness();
	const { evaluateMetadataSyncFilter } = load('src/syncFilter.ts');
	const context = {
		syncScope: 'reading',
		syncMode: 'blacklist',
		noteCountLimit: 10,
		saveArticleToggle: true,
		blacklistedBookIds: new Set(),
		whitelistedBookIds: new Set()
	};
	const book = { bookId: '123', noteCount: 0 };
	assert.equal(evaluateMetadataSyncFilter(book, context).includedByCurrentSettings, true);
	context.blacklistedBookIds.add('123');
	assert.equal(evaluateMetadataSyncFilter(book, context).includedByCurrentSettings, false);
	context.syncMode = 'whitelist';
	assert.equal(evaluateMetadataSyncFilter(book, context).includedByCurrentSettings, false);
	context.whitelistedBookIds.add('123');
	assert.equal(evaluateMetadataSyncFilter(book, context).includedByCurrentSettings, true);
});

test('pagination failures do not become empty success; duplicate cursors are rejected', async () => {
	const h = harness();
	const { settingsStore } = h.load('src/settings.ts');
	settingsStore.actions.setWereadApiKey('test-only');
	const Api = h.load('src/api-v2.ts').default;
	h.queue.push({ books: [{ bookId: '1', sort: 10 }], hasMore: 1 }, { errcode: -1 });
	await assert.rejects(() => new Api().getNotebooks());
	h.queue.push(
		{ books: [{ bookId: '1', sort: 10 }], hasMore: 1 },
		{ books: [{ bookId: '1', sort: 10 }], hasMore: 1 }
	);
	await assert.rejects(() => new Api().getNotebooks());
	h.queue.push(
		{ books: [{ bookId: '1', sort: 10 }], hasMore: 1 },
		{ books: [{ bookId: '2', sort: 9 }], hasMore: 0 }
	);
	assert.equal((await new Api().getNotebooks()).books.length, 2);
	assert.equal(h.requests.at(-1).lastSort, 10);
});

test('reviews include every page and reject a failed or non-advancing page', async () => {
	const h = harness();
	h.load('src/settings.ts').settingsStore.actions.setWereadApiKey('test-only');
	const Api = h.load('src/api-v2.ts').default;
	h.queue.push(
		{ reviews: [{ reviewId: 'a' }], hasMore: 1, synckey: 5 },
		{ reviews: [{ reviewId: 'b' }], hasMore: 0 }
	);
	assert.equal((await new Api().getNotebookReviews('123')).reviews.length, 2);
	assert.equal(h.requests.at(-1).synckey, 5);
	h.queue.push({ reviews: [], hasMore: 1, synckey: 0 });
	await assert.rejects(() => new Api().getNotebookReviews('123'));
	h.queue.push({ reviews: [], hasMore: 1, synckey: 1 }, { errcode: -1 });
	await assert.rejects(() => new Api().getNotebookReviews('123'));
});

test('empty YAML is accepted; malformed YAML boundaries are rejected', () => {
	const { splitFrontmatter } = harness().load('src/utils/managedSections.ts');
	assert.equal(splitFrontmatter('---\n---\nbody').body, 'body');
	assert.equal(splitFrontmatter('---\r\n---\r\nbody').yaml, '');
	assert.throws(() => splitFrontmatter('---\na: b\nbody'));
});

function notebook() {
	return {
		metaData: {
			bookId: '123',
			title: '测试书',
			author: '作者',
			cover: '',
			noteCount: 0,
			reviewCount: 0,
			lastReadDate: '2026-10-11',
			finishReading: 1,
			readInfo: { readingProgress: 28, readingTime: 60, readingBookDate: 0, finishedDate: 0 }
		},
		chapterHighlights: [],
		bookReview: { bookReviews: [], chapterReviews: [] }
	};
}

test('frontmatter preserves custom properties, uses marked finish and removes stale dates', () => {
	const { load } = harness();
	const { buildFrontMatter } = load('src/utils/frontmatter.ts');
	const { splitFrontmatter } = load('src/utils/managedSections.ts');
	const current =
		'---\ntags: [mine]\ncustom: keep\nfinishedDate: old\nreadingDate: old\n---\nbody';
	const result = buildFrontMatter('---\ncustom: remote\n---\nnew body', notebook(), current);
	const props = yaml.load(splitFrontmatter(result).yaml);
	assert.equal(props.custom, 'keep');
	assert.deepEqual(props.tags, ['mine']);
	assert.equal(props.readingStatus, '4');
	assert.equal(props.progress, '28%');
	assert.equal(props.finishedDate, undefined);
	assert.equal(props.readingDate, undefined);
	assert.throws(() => buildFrontMatter('body', notebook(), '---\nunclosed'));
});

test('atomic file update retains an edit made after the initial read, and skips identical output', async () => {
	const h = harness();
	const FileManager = h.load('src/fileManager.ts').default;
	const book = notebook();
	book.metaData.file = { file: { path: 'book.md' }, new: true };
	let content = '---\nbookId: "123"\ncustom: keep\n---\n' + legacy;
	let processCalls = 0;
	const vault = {
		read: async () => content,
		process: async (_file, callback) => {
			processCalls++;
			content = callback(content.replace('我的原文', '刚刚输入的原文'));
			return content;
		}
	};
	const manager = new FileManager(vault, {}, {});
	await manager.saveNotebook(book);
	assert.ok(content.includes('刚刚输入的原文'));
	assert.ok(content.includes('custom: keep'));
	await manager.saveNotebook(book);
	assert.equal(processCalls, 1);
});

test('all built-in themes produce managed regions and an empty local notes section', () => {
	const h = harness();
	const { BUILT_IN_THEMES } = h.load('src/settings.ts');
	const Renderer = h.load('src/renderer.ts').Renderer;
	const { prepareNotebookBody, splitFrontmatter } = h.load('src/utils/managedSections.ts');
	for (const theme of BUILT_IN_THEMES) {
		const rendered = new Renderer().renderWithTemplate(
			theme.template,
			notebook(),
			theme.trimBlocks
		);
		const managed = prepareNotebookBody(splitFrontmatter(rendered).body, true);
		assert.match(managed, /# 读书笔记\r?\n\r?\n# 本书评论/);
		assert.ok(!managed.includes('<!-- weread:'));
	}
});

test('full sync and force sync update zero-highlight books without touching personal notes', async () => {
	const h = harness();
	const FileManager = h.load('src/fileManager.ts').default;
	const Sync = h.load('src/syncNotebooks.ts').default;
	const { settingsStore } = h.load('src/settings.ts');
	const file = { path: 'book.md', basename: '测试书' };
	let content =
		'---\ndoc_type: weread-highlights-reviews\nbookId: "123"\nnoteCount: 0\nreviewCount: 0\n---\n' +
		legacy;
	const vault = {
		getMarkdownFiles: () => [file],
		read: async () => content,
		process: async (_file, fn) => (content = fn(content))
	};
	const metadata = { getFileCache: () => ({ frontmatter: yaml.load(content.split('---')[1]) }) };
	let progress = 42;
	let failReviews = false;
	let reviewContent = '';
	const api = {
		getShelf: async () => ({ books: [{ bookId: '123', title: '测试书', finishReading: 0 }] }),
		getReadingNotebooks: async () => [],
		getReadingProgress: async () => ({
			book: { progress, readingTime: 100, startReadingTime: 0, finishTime: 0 }
		}),
		getBook: async () => ({ title: '测试书', newRating: 80 }),
		getNotebookHighlights: async () => ({ updated: [], chapters: [] }),
		getNotebookReviews: async () =>
			failReviews
				? undefined
				: {
						reviews: reviewContent
							? [
									{
										review: {
											type: 4,
											content: reviewContent,
											createTime: 1,
											reviewId: 'r1'
										}
									}
								]
							: []
					},
		getChapters: async () => ({ data: [{ updated: [] }] })
	};
	const sync = new Sync(new FileManager(vault, metadata, {}), api, vault);
	assert.equal(await sync.syncNotebooks(false, '2026-10-11'), 1);
	assert.ok(content.includes('progress: 42%'));
	assert.ok(content.includes('# 读书笔记\n我的原文\n## 我的分析\n\n'));
	progress = 50;
	reviewContent = '远端的新书评';
	assert.equal(await sync.syncNotebooks(true, '2026-10-11'), 1);
	assert.ok(content.includes('progress: 50%'));
	assert.ok(content.includes('远端的新书评'));
	assert.ok(content.includes('# 读书笔记\n我的原文\n## 我的分析\n\n'));
	const beforeFailure = content;
	failReviews = true;
	assert.equal(await sync.syncNotebooks(true, '2026-10-11'), 0);
	assert.equal(content, beforeFailure);
	assert.equal(require('svelte/store').get(settingsStore).syncLogs[0].success, false);
});

test('writer failures propagate and do not overwrite files with malformed boundaries', async () => {
	const h = harness();
	const FileManager = h.load('src/fileManager.ts').default;
	const book = notebook();
	book.metaData.file = { file: { path: 'book.md' }, new: true };
	let calls = 0;
	const manager = new FileManager(
		{
			read: async () => '# 私人文件\n不可覆盖',
			process: async () => {
				calls++;
			}
		},
		{},
		{}
	);
	await assert.rejects(() => manager.saveNotebook(book));
	assert.equal(calls, 0);
});

module.exports = { harness };

test('each managed section ends at the next heading and reviews end at EOF', () => {
 const { mergeManagedSections } = harness().load('src/utils/managedSections.ts');
 const result = mergeManagedSections(legacy + 'old review appendix', fresh);
 assert.ok(!result.includes('old metadata'));
 assert.ok(!result.includes('old highlights'));
 assert.ok(!result.includes('old review'));
 assert.ok(result.endsWith('new review\n'));
 assert.equal(mergeManagedSections(result, fresh), result);
});


test('bookshelf first paint is local, refreshes coalesce and failed refresh retains cache', async () => {
 const h = harness();
 const Service = h.load('src/bookshelf.ts').default;
 const store = h.load('src/settings.ts').settingsStore;
 store.actions.setWereadApiKey('account-a');
 let release;
 let requests = 0;
 let fail = false;
 const gate = new Promise((resolve) => { release = resolve; });
 const api = {
  getShelf: async () => { requests++; if (fail) throw new Error('offline'); await gate; return { books: [{ bookId: 'remote', title: '远端书', finishReading: 1 }] }; },
  getReadingNotebooks: async () => [],
  getReadingProgress: async () => ({ book: { progress: 100 } })
 };
 let files = new Map([['local', { bookId: 'local', title: '本地书', file: { basename: '本地书' } }]]);
 const service = new Service({ getNotebookFilesByBookId: async () => files }, api);
 const initial = await service.getInitialBookshelfBooks();
 assert.equal(initial.localOnly, true);
 assert.equal(initial.books[0].title, '本地书');
 assert.equal(requests, 0);
 const first = service.getBookshelfBooks();
 const second = service.getBookshelfBooks();
 assert.equal(requests, 1);
 release();
 await Promise.all([first, second]);
 files = new Map();
 const cached = await service.getInitialBookshelfBooks();
 assert.equal(cached.localOnly, false);
 assert.equal(cached.books.length, 1);
 assert.equal(cached.books[0].title, '远端书');
 fail = true;
 await assert.rejects(service.getBookshelfBooks());
 assert.equal((await service.getInitialBookshelfBooks()).books[0].title, '远端书');
 store.actions.setWereadApiKey('account-b');
 assert.equal((await service.getInitialBookshelfBooks()).localOnly, true);
 assert.equal((await service.getInitialBookshelfBooks()).books.length, 0);
});

test('bookshelf renders before remote resolves and ignores responses after closing', async () => {
 const h = harness();
 h.load('src/settings.ts').settingsStore.actions.setWereadApiKey('test-only');
 const View = h.load('src/components/wereadBookshelf.ts').WereadBookshelfView;
 let release;
 const remote = new Promise((resolve) => { release = resolve; });
 const view = Object.create(View.prototype);
 const local = [{ bookId: 'local' }];
 let painted;
 view.loadGeneration = 0;
 view.bookshelfService = { getInitialBookshelfBooks: async () => ({ books: local, localOnly: true }), getBookshelfBooks: () => remote };
 view.renderBooks = () => { painted = view.shelfBooks; };
 view.refreshStatusEl = { setText() {} };
 view.contentEl = { empty() {} };
 const loading = view.loadBookshelf();
 await new Promise((resolve) => setImmediate(resolve));
 assert.equal(painted, local);
 await view.onClose();
 release([{ bookId: 'remote' }]);
 await loading;
 assert.equal(painted, local);
});


test('community mapping routes only public content and unlink restores original book', async () => {
 const h = harness();
 const store = h.load('src/settings.ts').settingsStore;
 const View = h.load('src/components/wereadBookDetailView.ts').WereadBookDetailView;
 const view = Object.create(View.prototype);
 view.bookId = 'CB_imported'; view.requestGeneration = 0;
 view.renderLoadingState = () => {};
 const calls = [];
 view.apiRouter = {};
 for (const method of ['getBook', 'getProgress', 'getNotebookHighlights', 'getNotebookReviews', 'getBestBookmarks', 'getPublicReviews']) {
  view.apiRouter[method] = async (id) => { calls.push([method, id]); return { items: [], chapters: [], reviews: [] }; };
 }
 store.actions.setCommunityBook('CB_imported', { bookId: '123', title: '书城版', author: '作者' });
 await view.loadAllData();
 assert.deepEqual(calls.slice(0, 4).map((call) => call[1]), Array(4).fill('CB_imported'));
 assert.deepEqual(calls.slice(4).map((call) => call[1]), ['123', '123']);
 assert.equal(view.communitySource.bookId, '123');
 assert.ok(view.buildDeepLink(47, '10-20', view.communitySource.bookId).includes('bookId=123'));
 assert.ok(view.buildDeepLink(3, '10-20').includes('bookId=CB_imported'));
 store.actions.setCommunityBook('CB_imported');
 calls.length = 0;
 await view.loadAllData();
 assert.equal(view.communitySource, undefined);
 assert.ok(calls.every((call) => call[1] === 'CB_imported'));
});

test('community search accepts scope 17 response groups and deduplicates book IDs', async () => {
 const h = harness();
 h.load('src/settings.ts').settingsStore.actions.setWereadApiKey('test-only');
 h.queue.push({ results: [{ scope: 17, books: [{ bookInfo: { bookId: '123', title: '书城版', author: '作者' } }, { bookInfo: { bookId: '123', title: '书城版', author: '作者' } }] }] });
 const Router = h.load('src/api-router.ts').default;
 const books = await new Router().searchCommunityBooks('书城版');
 assert.equal(books.length, 1);
 assert.equal(books[0].bookId, '123');
 assert.equal(h.requests[0].scope, 10);
 assert.equal(h.requests[0].keyword, '书城版');
});


test('title filtering handles both parentheses, nested groups and whitelist', () => {
 const { formatBookTitle } = harness().load('src/utils/sanitizeTitle.ts');
 const enabled = { removeParens: true };
 assert.equal(formatBookTitle('死灵之书(珍藏版)', enabled), '死灵之书');
 assert.equal(formatBookTitle('书名（上册）正文(附录)', enabled), '书名正文');
 assert.equal(formatBookTitle('书名（修订(第二版)）', enabled), '书名');
 assert.equal(formatBookTitle('书名(未闭合', enabled), '书名(未闭合');
 assert.equal(formatBookTitle('书名(版本)', { removeParens: false }), '书名(版本)');
 assert.equal(formatBookTitle('书名(版本)', { ...enabled, removeParensWhitelist: '书名' }), '书名(版本)');
});


test('export encodes large imported covers safely and rejects non-images', () => {
 const { imageDataUrl, exportErrorMessage } = harness().load('src/utils/exportImage.ts');
 const bytes = new Uint8Array(900000);
 bytes.set([255,216,255]);
 const url = imageDataUrl(bytes.buffer);
 assert.ok(url.startsWith('data:image/jpeg;base64,'));
 assert.deepEqual(Buffer.from(url.split(',')[1], 'base64'), Buffer.from(bytes));
 assert.ok(imageDataUrl(Uint8Array.from([137,80,78,71,13,10,26,10]).buffer).startsWith('data:image/png;'));
 assert.throws(() => imageDataUrl(Uint8Array.from([60,104,116,109,108]).buffer));
 assert.ok(!exportErrorMessage({ type: 'error' }).includes('undefined'));
});
