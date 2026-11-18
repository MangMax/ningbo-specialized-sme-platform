// Use the identical root/extension/existence checks as GET. An explicit HEAD
// route prevents missing files falling through to the application's HTML page.
export { default } from './[...path].get'
