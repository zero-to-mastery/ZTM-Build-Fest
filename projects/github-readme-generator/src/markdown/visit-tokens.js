// Marked's general visitor concatenates callback result arrays. Our analysis needs
// side effects only, so traverse in source order without accumulating those arrays.
export function visitTokens(tokens, visit) {
  const stack = [{ tokens, index: 0 }];
  while (stack.length) {
    const frame = stack.at(-1);
    if (frame.index === frame.tokens.length) {
      stack.pop();
      continue;
    }
    const token = frame.tokens[frame.index++];
    visit(token);
    let children = token.tokens;
    if (token.type === "list") children = token.items;
    if (token.type === "table")
      children = [...token.header, ...token.rows.flat()].flatMap(
        (cell) => cell.tokens,
      );
    if (children?.length) stack.push({ tokens: children, index: 0 });
  }
}
