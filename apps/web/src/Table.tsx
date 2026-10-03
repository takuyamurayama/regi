import { Icon } from './Icon';

export function Table({ headers, rows }: { headers: string[]; rows: any[][] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {headers.map((header) => (
              <th scope="col" key={header}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, column) => (
                  <td className={String(cell ?? '').startsWith('¥') ? 'numeric' : ''} key={column}>
                    {cell ?? '—'}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={headers.length}>
                <div className="empty">
                  <span className="empty-icon">
                    <Icon name="folder" />
                  </span>
                  <span>この条件の記録はありません</span>
                  <small>店舗や期間を変更すると、該当する記録を確認できます。</small>
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
