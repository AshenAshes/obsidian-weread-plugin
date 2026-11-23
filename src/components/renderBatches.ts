/** Append rows on demand and return the cleanup for the current list. */
export function renderBatches<T>(
	container: HTMLElement,
	items: readonly T[],
	batchSize: number,
	unit: string,
	append: (batch: readonly T[]) => void
): () => void {
	append(items.slice(0, batchSize));
	if (items.length <= batchSize) return () => undefined;

	let offset = batchSize;
	let disposed = false;
	const controls = container.createDiv({ cls: 'weread-load-more' });
	const button = controls.createEl('button', { attr: { type: 'button' } });
	const Observer = container.ownerDocument?.defaultView?.IntersectionObserver;
	const observer = Observer ? new Observer((entries) => {
		if (entries.some((entry) => entry.isIntersecting)) loadMore();
	}, { rootMargin: '240px 0px' }) : undefined;

	function dispose() {
		if (disposed) return;
		disposed = true;
		observer?.disconnect();
		button.onclick = null;
		controls.remove();
	}

	function updateLabel() {
		button.setText(`加载更多（剩余 ${items.length - offset} ${unit}）`);
	}

	function loadMore() {
		if (disposed) return;
		const next = Math.min(offset + batchSize, items.length);
		append(items.slice(offset, next));
		offset = next;
		if (offset === items.length) dispose();
		else {
			if (container.lastElementChild !== controls) {
				const focused = controls.ownerDocument.activeElement === button;
				container.appendChild(controls);
				if (focused) button.focus({ preventScroll: true });
			}
			updateLabel();
		}
	}

	button.onclick = loadMore;
	updateLabel();
	observer?.observe(controls);
	return dispose;
}
