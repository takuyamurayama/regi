export function parseCsv(input: string): Record<string, string>[] {
  const table: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  const source = input.replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        cell += '"';
        index++;
      } else {
        if (!quoted && cell !== '') throw new Error('CSVの引用符が不正です');
        quoted = !quoted;
      }
    } else if (!quoted && (character === ',' || character === '\n' || character === '\r')) {
      row.push(cell);
      cell = '';
      if (character !== ',') {
        if (row.some((value) => value !== '')) table.push(row);
        row = [];
        if (character === '\r' && source[index + 1] === '\n') index++;
      }
    } else cell += character;
  }
  if (quoted) throw new Error('CSVの引用符が閉じていません');
  row.push(cell);
  if (row.some((value) => value !== '')) table.push(row);
  const headers = table.shift();
  if (!headers?.length || new Set(headers).size !== headers.length)
    throw new Error('CSVの見出しが不正です');
  return table.map((values) => {
    if (values.length !== headers.length) throw new Error('CSVの列数が一致しません');
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}
