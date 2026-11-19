// Nitro's explicit /api/files/:id PATCH/DELETE route shadows the catch-all for
// single-segment GETs. Reuse the same read-only handler for root-level files.
export { default } from './[...path].get'
