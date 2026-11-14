export async function threadsTick() { return null; }
export async function threadsPublishTick() { return null; }
export async function threadsReportText() { return ''; }
export async function threadsStatus() { return []; }
export async function threadsAcceptToken() { return { status: 200, body: { ok: true } }; }
export async function threadsPublicStatus() { return new Response('ok'); }

export async function instagramTick() { return null; }
export async function instagramAcceptToken() { return { status: 200, body: { ok: true } }; }
export async function instagramPublicStatus() { return new Response('ok'); }
export async function instagramDebug() { return { ok: true }; }

export async function youtubeTick() { return null; }
export async function youtubeAcceptToken() { return { status: 200, body: { ok: true } }; }
export async function youtubePublicStatus() { return new Response('ok'); }
export async function youtubeDebug() { return { ok: true }; }

export async function tiktokTick() { return null; }
export async function tiktokAcceptKeys() { return { status: 200, body: { ok: true } }; }
export async function tiktokConnect() { return new Response('ok'); }
export async function tiktokCallback() { return new Response('ok'); }
export async function tiktokPublicStatus() { return new Response('ok'); }
export async function tiktokDebug() { return { ok: true }; }
