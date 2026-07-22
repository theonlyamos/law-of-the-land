export async function countRows(rows: AsyncIterable<unknown>): Promise<number> {
  let count = 0;

  for await (const _row of rows) {
    count += 1;
  }

  return count;
}
