// Run this case with node --test tests/favoritesInternal.mjs.
// Persistence stays in memory and never connects to a user vault.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { build } from 'esbuild';

const compiled = await build({
	stdin: {
		contents:
			"export * from './src/favorites'; export * from './src/favoritesCanvas'; export * from './src/favoritesRepository';",
		resolveDir: process.cwd(),
		loader: 'ts'
	},
	bundle: true,
	platform: 'node',
	format: 'cjs',
	write: false
});
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(
	createRequire(import.meta.url),
	module,
	module.exports
);
const { WereadFavoritesService, serializeFavoritesCanvas, favoritesPaths, parseFavorites } =
	module.exports;
const internalFolder = '.obsidian/plugins/ashenashes-weread';
const internal = favoritesPaths(internalFolder);
const publicPaths = favoritesPaths();
const note = {
	id: '42:highlight:sample',
	bookId: '42',
	bookTitle: '示例书籍',
	author: '作者',
	kind: 'highlight',
	text: '保留完整收藏正文',
	createTime: 1700000000000,
	bookType: 0
};

function fixture(t, initial = []) {
	const files = new Map(initial);
	const directories = new Set(['.obsidian', '.obsidian/plugins', internalFolder]);
	const operations = [];
	const options = { folder: '', locationVersion: 1 };
	const faults = {};
	const adapter = {
		async exists(path) {
			return files.has(path) || directories.has(path);
		},
		async read(path) {
			if (!files.has(path)) throw Error('missing');
			return files.get(path);
		},
		async write(path, raw) {
			if (faults.fail === path) throw Error('synthetic disk failure');
			operations.push(['write', path]);
			files.set(path, raw);
		},
		async mkdir(path) {
			directories.add(path);
		},
		async remove(path) {
			operations.push(['remove', path]);
			files.delete(path);
		},
		async list(folder) {
			const prefix = folder ? folder + '/' : '';
			return {
				files: [...files.keys()].filter(
					(path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/')
				),
				folders: []
			};
		}
	};
	function restart() {
		const service = new WereadFavoritesService(
			{ app: { vault: { adapter } } },
			{
				...options,
				internalFolder,
				async commitLocation(folder, version) {
					if (faults.commit) throw Error('synthetic settings failure');
					options.folder = folder;
					options.locationVersion = version;
				}
			}
		);
		t.after(() => service.dispose());
		return service;
	}
	return { files, operations, options, faults, restart };
}

test('favorites work after visible files are deleted and only write inside the plugin directory', async (t) => {
	const f = fixture(t),
		service = f.restart();
	assert.equal((await service.load()).writable, true);
	await service.setFavorite(note, true);
	assert.equal(service.getSnapshot().favorites.length, 1);
	assert(f.operations.every(([, path]) => path.startsWith(internalFolder + '/')));
	assert.equal(f.options.locationVersion, 2);
	const restarted = f.restart();
	assert.equal((await restarted.load()).favorites[0].note.text, note.text);
	assert.equal(restarted.getSnapshot().error, '');
	const original = restarted.getSnapshot().favorites[0];
	await restarted.remove(note.id);
	assert.equal(restarted.isFavorite(note.id), false);
	await restarted.restore(original);
	assert.equal(restarted.isFavorite(note.id), true);
	assert.equal(parseFavorites(f.files.get(internal.primary)).records.length, 1);
});

function snapshot(revision, text) {
	const { bookType, ...stored } = note;
	return serializeFavoritesCanvas({
		schemaVersion: 1,
		revision,
		records: [
			{
				id: note.id,
				note: { ...stored, text },
				favoritedAt: 1700000000001,
				updatedAt: 1700000000002
			}
		]
	});
}

test('existing Canvas snapshots migrate with manual content before public files are removed', async (t) => {
	const graph = JSON.parse(snapshot(4, '迁移的收藏'));
	graph.nodes.push({
		id: 'manual',
		type: 'text',
		x: 900,
		y: 0,
		width: 300,
		height: 200,
		text: '手工画布内容'
	});
	const raw = JSON.stringify(graph);
	const f = fixture(t, [
		[publicPaths.primary, raw],
		[publicPaths.backup, raw],
		[publicPaths.staging, raw]
	]);
	const service = f.restart();
	const state = await service.load();
	assert.equal(state.writable, true);
	assert.equal(state.favorites[0].note.text, '迁移的收藏');
	for (const path of [publicPaths.primary, publicPaths.backup, publicPaths.staging])
		assert(!f.files.has(path));
	assert.equal(f.files.get(internal.primary), raw);
	assert.equal(
		JSON.parse(f.files.get(internal.primary)).nodes.find((node) => node.id === 'manual').text,
		'手工画布内容'
	);
	assert(
		!f.operations.some(
			([kind, path]) => kind === 'write' && !path.startsWith(internalFolder + '/')
		)
	);
	assert.equal((await f.restart().load()).favorites.length, 1);
});

test('a missing public primary recovers the latest valid snapshot without recreating public files', async (t) => {
	const f = fixture(t, [
		[publicPaths.backup, snapshot(3, '较早备份')],
		[publicPaths.staging, snapshot(4, '较新备份')]
	]);
	const state = await f.restart().load();
	assert.equal(state.writable, true);
	assert.equal(state.error, '');
	assert.equal(state.favorites[0].note.text, '较新备份');
	assert(!f.files.has(publicPaths.primary));
	assert(
		!f.operations.some(
			([kind, path]) => kind === 'write' && !path.startsWith(internalFolder + '/')
		)
	);
});

test('failed import settings commit retries from internal storage and failed favorite writes remain retryable', async (t) => {
	const raw = snapshot(4, '恢复收藏');
	const f = fixture(t, [[publicPaths.primary, raw]]);
	f.faults.commit = true;
	assert.equal((await f.restart().load()).writable, false);
	f.faults.commit = false;
	const service = f.restart();
	assert.equal((await service.load()).favorites[0].note.text, '恢复收藏');
	f.faults.fail = internal.primary;
	await assert.rejects(service.remove(note.id));
	assert.equal(service.isFavorite(note.id), true);
	delete f.faults.fail;
	await service.remove(note.id);
	assert.equal(service.isFavorite(note.id), false);
});
