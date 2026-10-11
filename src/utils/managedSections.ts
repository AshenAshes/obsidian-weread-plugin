export function splitFrontmatter(text: string): { yaml?: string; body: string } {
	if (!/^---\r?\n/.test(text)) return { body: text };
	const match = text.match(/^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/);
	if (!match) throw new Error('YAML 属性边界不完整，已保留原文件');
	return { yaml: match[1] ?? '', body: text.slice(match[0].length) };
}

// Ignore headings inside fenced code blocks.
function structuralLines(text: string): { text: string; start: number; end: number }[] {
	const result: { text: string; start: number; end: number }[] = [];
	let fence: string | undefined;
	let offset = 0;
	for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
		const value = line.replace(/\r?\n$/, '');
		const delimiter = value.match(/^ {0,3}(`{3,}|~{3,})/);
		if (fence) {
			if (
				delimiter &&
				delimiter[1][0] === fence[0] &&
				delimiter[1].length >= fence.length &&
				value.slice(delimiter[0].length).trim() === ''
			) {
				fence = undefined;
			}
		} else if (delimiter) {
			fence = delimiter[1];
		} else {
			result.push({ text: value, start: offset, end: offset + line.length });
		}
		offset += line.length;
	}
	return result;
}

const HEADINGS = ['元数据', '高亮划线', '读书笔记', '本书评论'];

function sections(body: string): { start: number; end: number }[] {
	const headings = structuralLines(body).filter((line) => /^ {0,3}#(?:[ \t]+|$)/.test(line.text));
	if (headings.length !== HEADINGS.length || headings.some((line, i) =>
		line.text.replace(/^ {0,3}#[ \t]*/, '').replace(/[ \t]+#+[ \t]*$/, '').trim() !== HEADINGS[i]
	)) {
		throw new Error('需要按顺序保留元数据、高亮划线、读书笔记、本书评论四个一级标题，且不能有其他一级标题；已保留原文件');
	}
	return headings.map((line, i) => ({ start: line.start, end: headings[i + 1]?.start ?? body.length }));
}

/** Validate the four headings and leave the local section empty for new files. */
export function prepareNotebookBody(body: string, fresh = false): string {
	const ranges = sections(body);
	if (!fresh) return body;
	const newline = body.includes('\r\n') ? '\r\n' : '\n';
	return body.slice(0, ranges[2].start) + `# 读书笔记${newline}${newline}` + body.slice(ranges[3].start);
}

export function mergeManagedSections(existing: string, generated: string): string {
	const current = sections(existing);
	const fresh = sections(generated);
	let merged = existing;
	for (const index of [3, 1, 0]) {
		merged = merged.slice(0, current[index].start) +
			generated.slice(fresh[index].start, fresh[index].end) + merged.slice(current[index].end);
	}
	return merged;
}
