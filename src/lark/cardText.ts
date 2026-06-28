export function larkCardToText(card: unknown): string {
  const pieces: string[] = [];
  collectCardText(card, pieces);

  const seen = new Set<string>();
  const lines = pieces
    .map((piece) => piece.trim())
    .filter((piece) => {
      if (!piece || seen.has(piece)) return false;
      seen.add(piece);
      return true;
    });
  return lines.join("\n");
}

function collectCardText(node: unknown, out: string[]): void {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const child of node) collectCardText(child, out);
    return;
  }
  if (typeof node !== "object") return;

  const obj = node as Record<string, unknown>;
  const tag = obj.tag;
  if (
    (tag === "plain_text" || tag === "lark_md" || tag === "markdown") &&
    typeof obj.content === "string"
  ) {
    out.push(obj.content);
    return;
  }

  collectCardText(obj.header, out);
  collectCardText(obj.title, out);
  collectCardText(obj.text, out);
  collectCardText(obj.label, out);
  collectCardText(obj.placeholder, out);
  collectCardText(obj.body, out);
  collectCardText(obj.elements, out);
  collectCardText(obj.fields, out);
  collectCardText(obj.actions, out);
  collectCardText(obj.columns, out);
  collectCardText(obj.options, out);
}
