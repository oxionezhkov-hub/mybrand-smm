// Lets Node import worker.js in tests without pulling Threads' JSON import.
const STUBS = new Set([
  './threads/threads.js',
  './instagram/instagram.js',
  './youtube/youtube.js',
  './tiktok/tiktok.js',
]);

export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL || '';
  if (parent.endsWith('/worker.js') && STUBS.has(specifier)) {
    return {
      shortCircuit: true,
      url: new URL('./test-stubs.mjs', import.meta.url).href,
    };
  }
  return nextResolve(specifier, context);
}
