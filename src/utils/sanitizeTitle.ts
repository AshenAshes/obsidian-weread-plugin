import sanitize from 'sanitize-filename';

export const sanitizeTitle = (title: string): string => {
	const santizedTitle = title.replace(/[':#|]/g, '').trim();
	return sanitize(santizedTitle);
};

/** Share the existing filename rule with bookshelf display titles. */
export function formatBookTitle(
 title: string,
 settings: { removeParens: boolean; removeParensWhitelist?: string }
): string {
 const whitelist = (settings.removeParensWhitelist || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
 if (!settings.removeParens || whitelist.some((keyword) => title.includes(keyword))) return title;
 return title.replace(/（.*）/g, '');
}
