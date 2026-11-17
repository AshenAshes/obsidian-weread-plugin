import type { DataAdapter } from 'obsidian';
import {
	FavoritesRepository,
	FavoritesStorageError,
	FutureSchemaError,
	LEGACY_FAVORITES_DIRECTORY,
	favoritesPaths,
	parseFavorites
} from './favoritesRepository';

/** Recover a deleted public Canvas in memory so migration never recreates it in the vault. */
async function legacyRepository(
	adapter: DataAdapter,
	folder: string
): Promise<FavoritesRepository> {
	const paths = favoritesPaths(folder);
	const repository = new FavoritesRepository(adapter, folder);
	if (await adapter.exists(paths.primary)) return repository;
	const candidates: { raw: string; revision: number }[] = [];
	let foundRecoveryFile = false;
	for (const [name, raw] of await repository.storageSnapshot()) {
		if (
			name !== 'favorites.canvas.previous.json' &&
			name !== 'favorites.canvas.staging.json' &&
			!name.endsWith('.canvas')
		)
			continue;
		foundRecoveryFile = true;
		try {
			candidates.push({ raw, revision: parseFavorites(raw).revision });
		} catch (error) {
			if (error instanceof FutureSchemaError) throw error;
		}
	}
	if (!candidates.length) {
		if (foundRecoveryFile) throw new FavoritesStorageError('收藏恢复文件无法解析，请检查备份');
		return repository;
	}
	const recovered = candidates.sort((left, right) => right.revision - left.revision)[0].raw;
	const readable = new Proxy(adapter, {
		get(target, key) {
			if (key === 'exists')
				return async (path: string) => path === paths.primary || target.exists(path);
			if (key === 'read')
				return async (path: string) =>
					path === paths.primary && !(await target.exists(path))
						? recovered
						: target.read(path);
			const value = Reflect.get(target, key);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
	return new FavoritesRepository(readable, folder);
}

/** The existing verified-copy transaction preserves snapshots and any manually authored Canvas data. */
export async function loadInternalFavorites(
	adapter: DataAdapter,
	destination: FavoritesRepository,
	legacyFolder: string,
	migrated: boolean
) {
	if (migrated) return destination.load();
	for (const folder of new Set([legacyFolder, LEGACY_FAVORITES_DIRECTORY])) {
		if (folder === destination.paths.folder) continue;
		const source = await legacyRepository(adapter, folder);
		if (!(await source.hasStorage())) continue;
		await source.load();
		const snapshot = await source.storageSnapshot();
		const verify = await source.copyTo(destination);
		await verify();
		const result = await destination.load();
		try {
			for (const [name, raw] of snapshot) {
				const path = source.paths.folder ? source.paths.folder + '/' + name : name;
				if (!(await adapter.exists(path))) continue;
				if (
					(await adapter.read(path)) !== raw ||
					(await adapter.read(destination.paths.folder + '/' + name)) !== raw
				)
					throw new FavoritesStorageError('原收藏文件在迁移后发生变化');
				await adapter.remove(path);
			}
		} catch {
			return {
				...result,
				warning: '收藏已迁入插件内部，部分旧文件清理失败，可手动检查后删除。'
			};
		}
		return { ...result, warning: '' };
	}
	return destination.load();
}
