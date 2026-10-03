import type { CSSProperties, ReactNode } from 'react';

export type IconName =
  | 'overview'
  | 'products'
  | 'orders'
  | 'inventory'
  | 'refund'
  | 'clock'
  | 'sync'
  | 'settings'
  | 'store'
  | 'arrow'
  | 'calendar'
  | 'cash'
  | 'card'
  | 'qr'
  | 'download'
  | 'folder'
  | 'chevron'
  | 'check'
  | 'receipt'
  | 'crest'
  | 'coin'
  | 'chest'
  | 'scroll'
  | 'book'
  | 'compass';

const paths: Record<IconName, ReactNode> = {
  overview: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" />
    </>
  ),
  products: (
    <>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="M3 8v8l9 5 9-5V8M12 13v8M7.5 5.5l9 5" />
    </>
  ),
  orders: (
    <>
      <path d="M8 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3" />
      <rect x="8" y="2" width="8" height="6" rx="2" />
      <path d="M7 12h10M7 16h7" />
    </>
  ),
  inventory: (
    <>
      <path d="M3 21V8l9-5 9 5v13M3 10h18M8 21v-7h8v7M1 21h22" />
      <path d="M12 6v1" />
    </>
  ),
  refund: (
    <>
      <path d="M8 7H5l3-3M5 7l3 3M5 7h10a6 6 0 0 1 0 12h-5" />
      <path d="M8 15v6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  crest: (
    <>
      <path d="M5 3h14v12l-7 6-7-6V3Z" />
      <path d="M9 7h4l2 2-2 2H9V7Zm0 4v5m3-5 3 5" />
    </>
  ),
  coin: (
    <>
      <path d="m8 3-5 5v8l5 5h8l5-5V8l-5-5H8Z" />
      <path d="M10 7h5M10 12h4M10 17h5M9 7v10M12 5v14" />
    </>
  ),
  chest: (
    <>
      <path d="M3 10V7l3-3h12l3 3v3M3 10h18v10H3V10ZM7 4v6M17 4v6M7 14v6M17 14v6" />
      <path d="M10 10h4v5h-4v-5Z" />
    </>
  ),
  scroll: (
    <>
      <path d="M7 3h12v15l-3 3H5l-2-2v-3h4V3Zm0 0H5L3 5v3h4M7 16v3l-2 2M11 7h5M11 11h5M11 15h3" />
    </>
  ),
  book: (
    <>
      <path d="M3 4h6l3 2 3-2h6v15h-6l-3 2-3-2H3V4ZM12 6v15M6 8h3M6 12h3M15 8h3M15 12h3" />
    </>
  ),
  compass: (
    <>
      <path d="m8 3-5 5v8l5 5h8l5-5V8l-5-5H8Z" />
      <path d="m15 8-2 5-5 2 2-5 5-2ZM12 3v2M12 19v2M3 12h2M19 12h2" />
    </>
  ),
  sync: (
    <>
      <path d="M20 7a8.5 8.5 0 0 0-14-2L3 8M3 3v5h5M4 17a8.5 8.5 0 0 0 14 2l3-3M21 21v-5h-5" />
    </>
  ),
  settings: (
    <>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" />
    </>
  ),
  store: (
    <>
      <path d="M4 10v10h16V10M3 10l2-7h14l2 7M3 10c0 3 4.5 3 4.5 0 0 3 4.5 3 4.5 0 0 3 4.5 3 4.5 0 0 3 4.5 3 4.5 0M9 20v-6h6v6" />
    </>
  ),
  arrow: (
    <>
      <path d="M4 12h15M13 6l6 6-6 6" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M7 3v4M17 3v4M3 10h18M8 14h2M14 14h2M8 17h2" />
    </>
  ),
  cash: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="3" />
      <circle cx="12" cy="12" r="3" />
      <path d="M6 12h.01M18 12h.01" />
    </>
  ),
  card: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="3" />
      <path d="M2 9h20M6 15h3" />
    </>
  ),
  qr: (
    <>
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <rect x="15" y="3" width="6" height="6" rx="1" />
      <rect x="3" y="15" width="6" height="6" rx="1" />
      <path d="M15 15h3v3h3M15 21h3M21 12v3M12 3v3M3 12h3M12 12h3M12 18v3" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12M7 10l5 5 5-5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </>
  ),
  folder: (
    <>
      <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2M3 7h16a2 2 0 0 1 2 2l-2 11H5L3 7Z" />
    </>
  ),
  chevron: <path d="m8 10 4 4 4-4" />,
  check: <path d="m5 12 4 4L19 6" />,
  receipt: (
    <>
      <path d="M5 3h14v18l-3-2-4 2-4-2-3 2V3Z" />
      <path d="M9 7h6M9 11h6M9 15h3" />
    </>
  ),
};

export function Icon({
  name,
  className = '',
  style,
}: {
  name: IconName;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={'icon ' + className}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
