/** First "{" to last "}" (free-text mode; also strips code fences and thinking residue). */
export function extractJsonObject(text: string): string {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  return a >= 0 && b > a ? text.slice(a, b + 1) : text;
}
