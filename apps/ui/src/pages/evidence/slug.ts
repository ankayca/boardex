// GitHub-style heading slugs (T6.3). A markdown document's headings get slug ids so
// a check's sourceDoc.locator can deep-link to the exact section — the mock's
// authored datasheet headings ("I2C device addressing", "Timing specifications")
// slugify to the exact locators the fixtures cite. The algorithm mirrors GitHub's:
// lowercase, drop everything that is not a word char / space / hyphen, then spaces
// to hyphens. `\w` is [A-Za-z0-9_], so digits and letters survive and punctuation
// (§, ., :, parentheses) is dropped.
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}
