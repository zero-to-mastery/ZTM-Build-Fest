// Browser integration only: one clock sample supplies both explicit contexts.
export function projectionContext(asOf = Date.now()) {
  const date = new Date(asOf);
  return {
    asOf,
    civilDate: date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate(),
  };
}
